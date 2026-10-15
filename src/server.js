import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(APP_ROOT, "node_modules", "@framer", "agent", "dist", "cli.js");
const STATE_ROOT = process.env.FRAMER_STATE_DIR || path.join(os.tmpdir(), "framer-cli-mcp");
const MAX_CODE_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 200_000;
const CLI_TIMEOUT_MS = 240_000;
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-11-25"]);

let cliQueue = Promise.resolve();

function serializeCli(operation) {
  const result = cliQueue.then(operation, operation);
  cliQueue = result.catch(() => undefined);
  return result;
}

function validateProjectApiKey(value) {
  const key = String(value || "").trim();
  if (key.length < 8 || key.length > 500 || /\s/.test(key)) {
    throw new Error(
      `${SETUP_GUIDE}\n\nMissing or invalid projectApiKey. Call framer_setup_guide, ask the user for this thread's project link and API key, then run framer_project_auth with:\n${AUTH_EXAMPLE}`
    );
  }
  return key;
}

function defaultApiKey() {
  const key = String(process.env.FRAMER_API_KEY || "").trim();
  return key || undefined;
}

function validateProjectRef(value) {
  const projectRef = String(value || "").trim();
  if (!projectRef || projectRef.length > 500) {
    throw new Error(
      `${SETUP_GUIDE}\n\nMissing projectUrlOrId. Ask the user for this thread's project link, then continue with framer_project_auth.`
    );
  }
  if (/^[A-Za-z0-9_-]{6,160}$/.test(projectRef) && !projectRef.startsWith("-")) {
    return projectRef;
  }
  let url;
  try {
    url = new URL(projectRef);
  } catch {
    throw new Error("Project reference must be a Framer project URL or an alphanumeric project ID.");
  }
  const allowedHosts = new Set(["framer.com", "www.framer.com"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || !/^\/(projects|remix)\/[^/]+/.test(url.pathname)) {
    throw new Error("Use an HTTPS Framer project or remix URL.");
  }
  return projectRef;
}

function validateSessionId(value) {
  const sessionId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(sessionId) || sessionId.startsWith("-")) {
    throw new Error("Invalid Framer session ID.");
  }
  return sessionId;
}

// The relay assigns short session IDs (e.g. "1"), but MCP clients validate
// sessionId with a minimum length of 8. Issue a stable >=8-char alias per
// session and map it back to the relay ID for CLI calls.
const sessionIdAliases = new Map();

function toClientSessionId(relaySessionId, projectRef) {
  const id = String(relaySessionId || "").trim();
  if (/^[A-Za-z0-9_-]{8,160}$/.test(id) && !id.startsWith("-")) {
    sessionIdAliases.set(id, { relayId: id, projectRef });
    return id;
  }
  // Do not expose the relay's short, often sequential IDs as bearer tokens.
  const alias = `sess_${crypto.randomBytes(16).toString("hex")}`;
  sessionIdAliases.set(alias, { relayId: id, projectRef });
  return alias;
}

function resolveSessionId(value) {
  const sessionId = validateSessionId(value);
  return sessionIdAliases.get(sessionId)?.relayId || sessionId;
}

// Later calls in a thread may omit projectUrlOrId; the session knows its project.
function projectForSession(value) {
  const sessionId = validateSessionId(value);
  return sessionIdAliases.get(sessionId)?.projectRef;
}

function projectRefForSession(sessionId, requestedProjectRef) {
  const boundProjectRef = projectForSession(sessionId);
  const projectRef = validateProjectRef(requestedProjectRef || boundProjectRef || process.env.FRAMER_PROJECT_URL);
  if (boundProjectRef && projectRef !== boundProjectRef) {
    throw new Error("This session is bound to a different Framer project.");
  }
  return projectRef;
}

function sanitizeOutput(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text.slice(-MAX_OUTPUT_CHARS).trim();
}

function runCli(args, { env, cwd, secrets = [], timeoutMs = CLI_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = { value: "" };
    const err = { value: "" };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    const collect = (stream, target) => {
      stream.on("data", (chunk) => {
        if (target.value.length < MAX_OUTPUT_CHARS) {
          target.value += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - target.value.length);
        }
      });
    };
    collect(child.stdout, out);
    collect(child.stderr, err);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not launch the Framer CLI: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = sanitizeOutput(out.value, secrets);
      const stderr = sanitizeOutput(err.value, secrets);
      if (timedOut) {
        reject(new Error(`Framer CLI exceeded the ${Math.round(timeoutMs / 1000)}-second execution limit.`));
        return;
      }
      if (code !== 0) {
        const details = stderr || stdout || `process exited with ${signal || code}`;
        reject(new Error(`Framer CLI failed: ${details}`));
        return;
      }
      resolve(stdout || stderr);
    });
  });
}

async function ensureFramerSkills(env, workDir) {
  const skillsDir = path.join(env.HOME, ".agents", "skills", "framer");
  try {
    await fs.access(skillsDir);
    return;
  } catch {
    // Render's ephemeral filesystem resets lose installed skills; reinstall silently.
  }
  await runCli(["setup"], { env, cwd: workDir, timeoutMs: 120_000 });
}

async function executeFramer(projectRefInput, projectApiKeyInput, args, timeoutMs = CLI_TIMEOUT_MS) {
  const projectRef = validateProjectRef(projectRefInput || process.env.FRAMER_PROJECT_URL);
  const apiKey = validateProjectApiKey(projectApiKeyInput ?? defaultApiKey());
  const configHome = path.join(STATE_ROOT, "config");
  const stateHome = path.join(STATE_ROOT, "state");
  const workDir = path.join(STATE_ROOT, "work", crypto.createHash("sha256").update(projectRef).digest("hex").slice(0, 20));
  await Promise.all([
    fs.mkdir(configHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(stateHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(workDir, { recursive: true, mode: 0o700 }),
  ]);

  const env = { ...process.env };
  delete env.FRAMER_API_KEY;
  Object.assign(env, {
    HOME: path.join(STATE_ROOT, "home"),
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    NO_COLOR: "1",
  });
  await fs.mkdir(env.HOME, { recursive: true, mode: 0o700 });

  return serializeCli(async () => {
    await runCli(["project", "auth", projectRef, apiKey], {
      env,
      cwd: workDir,
      secrets: [apiKey],
      timeoutMs: 30_000,
    });
    await ensureFramerSkills(env, workDir);
    return runCli(args, { env, cwd: workDir, secrets: [apiKey], timeoutMs });
  });
}

function resultText(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], ...(isError ? { isError: true } : {}) };
}

const SETUP_GUIDE = [
  "Per-project setup (one thread per Framer project):",
  "1. Create a new thread for this project.",
  "2. Ask the user for this thread's project link: browser address bar, or app right-click project tab → Copy Project Link.",
  "3. Ask the user for this project's API key: Site Settings → General → API Keys.",
  "4. Call framer_project_auth once with that thread's projectUrlOrId and projectApiKey.",
  "5. Call framer_session_new once and reuse its sessionId for the whole thread.",
  "If the Render free instance restarted, call framer_project_auth again for that thread.",
].join("\n");

const AUTH_EXAMPLE = JSON.stringify(
  {
    projectUrlOrId: "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123",
    projectApiKey: "PASTE_THIS_PROJECTS_API_KEY",
  },
  null,
  2
);

const toolDefinitions = [
  {
    name: "framer_setup_guide",
    title: "Show per-project setup guide",
    description: "Show any agent how to guide a user through per-project setup: new thread per project, project link, project API key, framer_project_auth, then framer_session_new. Call this before asking the user for credentials.",
    schema: z.object({}).strict(),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => `${SETUP_GUIDE}\n\nframer_project_auth example:\n${AUTH_EXAMPLE}`,
  },
  {
    name: "framer_project_auth",
    title: "Authorize a Framer project",
    description: "STEP 1 for any new project thread. Save this thread's Framer project credentials on the hosted CLI using the project's own API key. Guide the user first: new thread per project; project link from browser address bar or app right-click → Copy Project Link; API key from Site Settings → General → API Keys. Then call this once with that thread's projectUrlOrId and projectApiKey. Later calls in the same thread can omit projectApiKey. Example: {\"projectUrlOrId\": \"https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123\", \"projectApiKey\": \"PASTE_THIS_PROJECTS_API_KEY\"}.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500),
      projectApiKey: z.string().min(8).max(500),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "This thread's Framer project URL or project ID. Ask the user: browser address bar, or app right-click project tab → Copy Project Link." },
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "This project's Framer API key from Site Settings → General → API Keys. Example: PASTE_THIS_PROJECTS_API_KEY." },
      },
      required: ["projectUrlOrId", "projectApiKey"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey }) => {
      const projectRef = validateProjectRef(projectUrlOrId);
      const apiKey = validateProjectApiKey(projectApiKey);
      const configHome = path.join(STATE_ROOT, "config");
      const stateHome = path.join(STATE_ROOT, "state");
      const workDir = path.join(STATE_ROOT, "work", crypto.createHash("sha256").update(projectRef).digest("hex").slice(0, 20));
      await Promise.all([
        fs.mkdir(configHome, { recursive: true, mode: 0o700 }),
        fs.mkdir(stateHome, { recursive: true, mode: 0o700 }),
        fs.mkdir(workDir, { recursive: true, mode: 0o700 }),
      ]);
      const env = { ...process.env, HOME: path.join(STATE_ROOT, "home"), XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, NO_COLOR: "1" };
      delete env.FRAMER_API_KEY;
      await fs.mkdir(env.HOME, { recursive: true, mode: 0o700 });
      const output = await serializeCli(() => runCli(["project", "auth", projectRef, apiKey], {
        env,
        cwd: workDir,
        secrets: [apiKey],
        timeoutMs: 30_000,
      }));
      return output || `Project ${projectRef} authorized for this thread.`;
    },
  },
  {
    name: "framer_session_new",
    title: "Create Framer agent session",
    description: "STEP 2 for any new project thread. Create one reusable session for this thread's Framer project using the official @framer/agent CLI. Authorize the project first with framer_project_auth, or pass this thread's projectApiKey inline. Reuse the returned sessionId for every later tool call in the thread; do not create replacement sessions.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      projectApiKey: z.string().min(8).max(500).optional(),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "This thread's Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured. If the user has not authorized this project yet, guide them with framer_setup_guide first." },
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "This thread's project API key. Required unless framer_project_auth was already called for it in this thread." },
      },
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey }) => {
      const projectRef = validateProjectRef(projectUrlOrId || process.env.FRAMER_PROJECT_URL);
      const output = await executeFramer(projectRef, projectApiKey ?? defaultApiKey(), ["session", "new", projectRef]);
      const sessionId = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()
        .find((line) => /^[A-Za-z0-9_-]{1,160}$/.test(line));
      if (!sessionId) throw new Error(`The CLI ran but its session ID could not be parsed. Output: ${output.slice(-2000)}`);
      return JSON.stringify({ sessionId: toClientSessionId(sessionId, projectRef), project: projectRef });
    },
  },
  {
    name: "framer_exec",
    title: "Execute code in a Framer session",
    description: "Run JavaScript in a Framer agent session via the official Framer CLI's generic exec command. This exposes the full Framer agent API available to this thread's authorized project. Only execute code against projects you are authorized to edit.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      projectApiKey: z.string().min(8).max(500).optional(),
      sessionId: z.string().min(8).max(160),
      code: z.string().min(1).max(MAX_CODE_CHARS),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "This thread's Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured." },
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "This project's Framer API key. Required unless framer_project_auth was already called for it." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS, description: "JavaScript code to execute through the Framer agent." },
      },
      required: ["sessionId", "code"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey, sessionId, code }) => {
      const projectRef = projectRefForSession(sessionId, projectUrlOrId);
      return executeFramer(projectRef, projectApiKey ?? defaultApiKey(), ["exec", "--session", resolveSessionId(sessionId), "--eval", code]);
    },
  },
  {
    name: "framer_apply_changes",
    title: "Apply changes to a Framer page",
    description: "Apply Framer canvas DSL changes to a page through the official Framer CLI.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      projectApiKey: z.string().min(8).max(500).optional(),
      sessionId: z.string().min(8).max(160),
      dsl: z.string().min(1).max(MAX_CODE_CHARS),
      pagePath: z.string().min(1).max(2048).optional(),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "This thread's Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured." },
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "This project's Framer API key. Required unless framer_project_auth was already called for it." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        dsl: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
        pagePath: { type: "string", minLength: 1, maxLength: 2048, description: "Target page path; defaults to '/'." },
      },
      required: ["sessionId", "dsl"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey, sessionId, dsl, pagePath }) => {
      const projectRef = projectRefForSession(sessionId, projectUrlOrId);
      return executeFramer(projectRef, projectApiKey ?? defaultApiKey(), ["apply-changes", "--session", resolveSessionId(sessionId), "--eval", dsl, "--page", pagePath || "/"]);
    },
  },
  {
    name: "framer_read_project",
    title: "Read Framer project data",
    description: "Run supported Framer project queries (such as fonts, guides, or screenshots) through the official Framer CLI.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      projectApiKey: z.string().min(8).max(500).optional(),
      sessionId: z.string().min(8).max(160),
      queries: z.string().min(2).max(50_000),
      pagePath: z.string().min(1).max(2048).optional(),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "This thread's Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured." },
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "This project's Framer API key. Required unless framer_project_auth was already called for it." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        queries: { type: "string", minLength: 2, maxLength: 50_000, description: "JSON array of Framer project query objects." },
        pagePath: { type: "string", minLength: 1, maxLength: 2048, description: "Target page path; defaults to '/'." },
      },
      required: ["sessionId", "queries"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey, sessionId, queries, pagePath }) => {
      const projectRef = projectRefForSession(sessionId, projectUrlOrId);
      let parsed;
      try {
        parsed = JSON.parse(queries);
      } catch {
        throw new Error("queries must be valid JSON.");
      }
      if (!Array.isArray(parsed)) throw new Error("queries must be a JSON array.");
      return executeFramer(projectRef, projectApiKey ?? defaultApiKey(), ["read-project", "--session", resolveSessionId(sessionId), "--queries", JSON.stringify(parsed), "--page", pagePath || "/"]);
    },
  },
  {
    name: "framer_session_destroy",
    title: "Destroy a Framer agent session",
    description: "Destroy a Framer agent session through the official Framer CLI.",
    schema: z.object({ sessionId: z.string().min(8).max(160) }).strict(),
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", minLength: 8, maxLength: 160 } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    run: async ({ sessionId }) => {
      const clientSessionId = validateSessionId(sessionId);
      const relaySessionId = sessionIdAliases.get(clientSessionId)?.relayId || clientSessionId;
      const configHome = path.join(STATE_ROOT, "config");
      const stateHome = path.join(STATE_ROOT, "state");
      const workDir = path.join(STATE_ROOT, "work");
      await Promise.all([
        fs.mkdir(configHome, { recursive: true, mode: 0o700 }),
        fs.mkdir(stateHome, { recursive: true, mode: 0o700 }),
        fs.mkdir(workDir, { recursive: true, mode: 0o700 }),
      ]);
      const env = { ...process.env, HOME: path.join(STATE_ROOT, "home"), XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, NO_COLOR: "1" };
      delete env.FRAMER_API_KEY;
      await fs.mkdir(env.HOME, { recursive: true, mode: 0o700 });
      return serializeCli(async () => {
        const output = await runCli(["session", "destroy", relaySessionId], { env, cwd: workDir });
        sessionIdAliases.delete(clientSessionId);
        return output || `Session ${sessionId} destroyed.`;
      });
    },
  },
];

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function supportedVersion(body, req) {
  const requested = body?.params?.protocolVersion;
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)) return requested;
  const headerVersion = req.get("mcp-protocol-version");
  if (headerVersion && SUPPORTED_PROTOCOL_VERSIONS.has(headerVersion)) return headerVersion;
  return DEFAULT_PROTOCOL_VERSION;
}

function toolList() {
  return toolDefinitions.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
}

async function handleMcp(req, res) {
  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== "object" || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return res.status(400).json(jsonRpcError(body?.id, -32700, "Invalid JSON-RPC request."));
  }
  const hasId = Object.prototype.hasOwnProperty.call(body, "id");
  const id = hasId ? body.id : null;
  if (body.method === "initialize") {
    if (!hasId) return res.status(400).json(jsonRpcError(null, -32600, "initialize must be a request with an id."));
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: supportedVersion(body, req),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "framer-cli-remote", version: "1.1.0" },
        setupGuide: SETUP_GUIDE,
        firstTool: "framer_setup_guide",
      },
    });
  }
  if (!hasId) {
    // MCP notifications have no response body; the client can reconnect without a server-side session.
    return res.status(202).end();
  }
  const headerVersion = req.get("mcp-protocol-version");
  if (headerVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(headerVersion)) {
    return res.status(400).json(jsonRpcError(id, -32000, "Unsupported MCP protocol version."));
  }
  if (body.method === "ping") return res.status(200).json({ jsonrpc: "2.0", id, result: {} });
  if (body.method === "tools/list") return res.status(200).json({ jsonrpc: "2.0", id, result: { tools: toolList() } });
  if (body.method === "tools/call") {
    const params = body.params || {};
    const tool = toolDefinitions.find((item) => item.name === params.name);
    if (!tool) {
      return res.status(200).json({ jsonrpc: "2.0", id, result: resultText(`Unknown tool: ${String(params.name || "")}`, true) });
    }
    const validation = tool.schema.safeParse(params.arguments ?? {});
    if (!validation.success) {
      const details = validation.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
      return res.status(200).json({ jsonrpc: "2.0", id, result: resultText(`Invalid tool arguments: ${details}`, true) });
    }
    try {
      const result = await tool.run(validation.data);
      return res.status(200).json({ jsonrpc: "2.0", id, result: resultText(result) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Framer CLI error.";
      return res.status(200).json({ jsonrpc: "2.0", id, result: resultText(message, true) });
    }
  }
  return res.status(200).json(jsonRpcError(id, -32601, `Method not found: ${body.method}`));
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb", strict: true }));
app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "framer-cli-mcp", setupGuide: SETUP_GUIDE, firstTool: "framer_setup_guide" }));
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, service: "framer-cli-mcp", setupGuide: SETUP_GUIDE, firstTool: "framer_setup_guide" }));
app.post("/mcp", (req, res) => void handleMcp(req, res));
app.all("/mcp", (_req, res) => res.status(405).json({ error: "Use POST /mcp." }));
app.use((_req, res) => res.status(404).json({ error: "Not found." }));
app.use((error, _req, res, _next) => {
  console.error("HTTP request error:", error instanceof Error ? error.message : "unknown error");
  if (error instanceof SyntaxError) return res.status(400).json({ error: "Invalid JSON request." });
  return res.status(500).json({ error: "Internal server error." });
});

const httpServer = http.createServer(app);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Framer CLI MCP listening on 0.0.0.0:${PORT}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  const forceExit = setTimeout(() => process.exit(1), 8_000);
  httpServer.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
