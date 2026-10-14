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

function constantTimeEqual(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function authorize(req) {
  const expected = process.env.MCP_AUTH_TOKEN;
  const header = req.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(expected && match && constantTimeEqual(match[1].trim(), expected));
}

function getApiKey() {
  const key = process.env.FRAMER_API_KEY;
  if (!key || key.trim().length < 8) {
    throw new Error("FRAMER_API_KEY is not configured on the Render service.");
  }
  return key.trim();
}

function validateProjectRef(value) {
  const projectRef = String(value || "").trim();
  if (!projectRef || projectRef.length > 500) {
    throw new Error("Provide a Framer project URL or project ID.");
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

async function executeFramer(projectRefInput, args, timeoutMs = CLI_TIMEOUT_MS) {
  const projectRef = validateProjectRef(projectRefInput || process.env.FRAMER_PROJECT_URL);
  const apiKey = getApiKey();
  const configHome = path.join(STATE_ROOT, "config");
  const stateHome = path.join(STATE_ROOT, "state");
  const workDir = path.join(STATE_ROOT, "work", crypto.createHash("sha256").update(projectRef).digest("hex").slice(0, 20));
  await Promise.all([
    fs.mkdir(configHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(stateHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(workDir, { recursive: true, mode: 0o700 }),
  ]);

  const env = { ...process.env };
  delete env.MCP_AUTH_TOKEN;
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
    return runCli(args, { env, cwd: workDir, secrets: [apiKey], timeoutMs });
  });
}

function resultText(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], ...(isError ? { isError: true } : {}) };
}

const toolDefinitions = [
  {
    name: "framer_session_new",
    title: "Create Framer agent session",
    description: "Create a session for an authorized Framer project using the official @framer/agent CLI. The session ID can be used with the other Framer tools.",
    schema: z.object({ projectUrlOrId: z.string().min(1).max(500).optional() }).strict(),
    inputSchema: {
      type: "object",
      properties: { projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured." } },
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId }) => {
      const projectRef = validateProjectRef(projectUrlOrId || process.env.FRAMER_PROJECT_URL);
      const output = await executeFramer(projectRef, ["session", "new", projectRef]);
      const sessionId = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()
        .find((line) => /^[A-Za-z0-9_-]{8,160}$/.test(line));
      if (!sessionId) throw new Error(`The CLI ran but its session ID could not be parsed. Output: ${output.slice(-2000)}`);
      return JSON.stringify({ sessionId, project: projectRef });
    },
  },
  {
    name: "framer_exec",
    title: "Execute code in a Framer session",
    description: "Run JavaScript in a Framer agent session via the official Framer CLI's generic exec command. This exposes the full Framer agent API available to the authenticated project. Only execute code against projects you are authorized to edit.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      sessionId: z.string().min(8).max(160),
      code: z.string().min(1).max(MAX_CODE_CHARS),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS, description: "JavaScript code to execute through the Framer agent." },
      },
      required: ["sessionId", "code"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, sessionId, code }) => {
      const projectRef = validateProjectRef(projectUrlOrId || process.env.FRAMER_PROJECT_URL);
      return executeFramer(projectRef, ["exec", "--session", validateSessionId(sessionId), "--eval", code]);
    },
  },
  {
    name: "framer_apply_changes",
    title: "Apply changes to a Framer page",
    description: "Apply Framer canvas DSL changes to a page through the official Framer CLI.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      sessionId: z.string().min(8).max(160),
      dsl: z.string().min(1).max(MAX_CODE_CHARS),
      pagePath: z.string().min(1).max(2048).optional(),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        dsl: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
        pagePath: { type: "string", minLength: 1, maxLength: 2048, description: "Target page path; defaults to '/'." },
      },
      required: ["sessionId", "dsl"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, sessionId, dsl, pagePath }) => {
      const projectRef = validateProjectRef(projectUrlOrId || process.env.FRAMER_PROJECT_URL);
      return executeFramer(projectRef, ["apply-changes", "--session", validateSessionId(sessionId), "--eval", dsl, "--page", pagePath || "/"]);
    },
  },
  {
    name: "framer_read_project",
    title: "Read Framer project data",
    description: "Run supported Framer project queries (such as fonts, guides, or screenshots) through the official Framer CLI.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      sessionId: z.string().min(8).max(160),
      queries: z.string().min(2).max(50_000),
      pagePath: z.string().min(1).max(2048).optional(),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        queries: { type: "string", minLength: 2, maxLength: 50_000, description: "JSON array of Framer project query objects." },
        pagePath: { type: "string", minLength: 1, maxLength: 2048, description: "Target page path; defaults to '/'." },
      },
      required: ["sessionId", "queries"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, sessionId, queries, pagePath }) => {
      const projectRef = validateProjectRef(projectUrlOrId || process.env.FRAMER_PROJECT_URL);
      let parsed;
      try {
        parsed = JSON.parse(queries);
      } catch {
        throw new Error("queries must be valid JSON.");
      }
      if (!Array.isArray(parsed)) throw new Error("queries must be a JSON array.");
      return executeFramer(projectRef, ["read-project", "--session", validateSessionId(sessionId), "--queries", JSON.stringify(parsed), "--page", pagePath || "/"]);
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
      const apiKey = getApiKey();
      const configHome = path.join(STATE_ROOT, "config");
      const stateHome = path.join(STATE_ROOT, "state");
      const workDir = path.join(STATE_ROOT, "work");
      await Promise.all([
        fs.mkdir(configHome, { recursive: true, mode: 0o700 }),
        fs.mkdir(stateHome, { recursive: true, mode: 0o700 }),
        fs.mkdir(workDir, { recursive: true, mode: 0o700 }),
      ]);
      const env = { ...process.env, HOME: path.join(STATE_ROOT, "home"), XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, NO_COLOR: "1" };
      delete env.MCP_AUTH_TOKEN;
      delete env.FRAMER_API_KEY;
      await fs.mkdir(env.HOME, { recursive: true, mode: 0o700 });
      return serializeCli(async () => {
        const output = await runCli(["session", "destroy", validateSessionId(sessionId)], { env, cwd: workDir, secrets: [apiKey] });
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
  if (!authorize(req)) {
    res.set("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Unauthorized" });
  }
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
        serverInfo: { name: "framer-cli-remote", version: "1.0.0" },
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
app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "framer-cli-mcp" }));
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, service: "framer-cli-mcp" }));
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
