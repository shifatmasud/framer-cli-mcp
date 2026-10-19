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
const AUTH_HANDLE_TTL_MS = 15 * 60 * 1000;
const MAX_AUTH_HANDLES = 512;
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-11-25"]);

let cliQueue = Promise.resolve();
const projectAuthHandles = new Map();
const sessionIdAliases = new Map();

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

function toClientSessionId(relaySessionId, projectRef) {
  const id = String(relaySessionId || "").trim();
  // The alias is also a bearer capability for keyless operations, so make it
  // unpredictable even when the upstream relay ID is already long enough.
  const alias = `sess_${crypto.randomBytes(16).toString("hex")}`;
  sessionIdAliases.set(alias, { relayId: id, projectRef });
  return alias;
}

function getSessionContext(value) {
  const sessionId = validateSessionId(value);
  const session = sessionIdAliases.get(sessionId);
  if (!session) {
    throw new Error("Unknown or expired Framer session. Reauthorize the project and create a new session.");
  }
  return session;
}

function resolveSessionId(value) {
  return getSessionContext(value).relayId;
}

function projectRefForSession(sessionId, requestedProjectRef) {
  const boundProjectRef = getSessionContext(sessionId).projectRef;
  const projectRef = validateProjectRef(requestedProjectRef || boundProjectRef);
  if (projectRef !== boundProjectRef) {
    throw new Error("This session is bound to a different Framer project.");
  }
  return projectRef;
}

function issueProjectAuthHandle(projectRef) {
  const now = Date.now();
  for (const [handle, record] of projectAuthHandles) {
    if (record.expiresAt <= now) projectAuthHandles.delete(handle);
  }
  while (projectAuthHandles.size >= MAX_AUTH_HANDLES) {
    const oldestHandle = projectAuthHandles.keys().next().value;
    if (!oldestHandle) break;
    projectAuthHandles.delete(oldestHandle);
  }
  const authHandle = `auth_${crypto.randomBytes(32).toString("hex")}`;
  projectAuthHandles.set(authHandle, { projectRef, expiresAt: now + AUTH_HANDLE_TTL_MS });
  return authHandle;
}

function consumeProjectAuthHandle(value, requestedProjectRef) {
  const authHandle = String(value || "").trim();
  const record = projectAuthHandles.get(authHandle);
  if (!record || record.expiresAt <= Date.now()) {
    projectAuthHandles.delete(authHandle);
    throw new Error("Missing, expired, or invalid authHandle. Run framer_project_auth again.");
  }
  if (requestedProjectRef && validateProjectRef(requestedProjectRef) !== record.projectRef) {
    throw new Error("This authorization handle is bound to a different Framer project.");
  }
  projectAuthHandles.delete(authHandle);
  return record.projectRef;
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

async function executeFramer(projectRefInput, projectApiKeyInput, args, timeoutMs = CLI_TIMEOUT_MS, { useSavedAuth = false } = {}) {
  const projectRef = validateProjectRef(projectRefInput || process.env.FRAMER_PROJECT_URL);
  const keyInput = projectApiKeyInput ?? defaultApiKey();
  const apiKey = keyInput ? validateProjectApiKey(keyInput) : undefined;
  if (!apiKey && !useSavedAuth) {
    throw new Error(`${SETUP_GUIDE}\n\nMissing projectApiKey or valid authorization handle.`);
  }
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
    if (apiKey) {
      await runCli(["project", "auth", projectRef, apiKey], {
        env,
        cwd: workDir,
        secrets: [apiKey],
        timeoutMs: 30_000,
      });
    }
    await ensureFramerSkills(env, workDir);
    return runCli(args, { env, cwd: workDir, secrets: apiKey ? [apiKey] : [], timeoutMs });
  });
}

function resultText(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], ...(isError ? { isError: true } : {}) };
}

const hasDefaultProject = Boolean(String(process.env.FRAMER_PROJECT_URL || "").trim());
const hasDefaultApiKey = Boolean(String(process.env.FRAMER_API_KEY || "").trim());
const hasCompleteServerAuth = hasDefaultProject && hasDefaultApiKey;

const SETUP_GUIDE = hasCompleteServerAuth
  ? [
      "Server-side Framer project defaults are configured for this MCP server.",
      "IMPORTANT: Do not ask the user to paste the project URL or API key when working on the configured project.",
      "Create a session by calling framer_session_new with empty arguments {}. The server supplies FRAMER_PROJECT_URL and FRAMER_API_KEY.",
      "Reuse the returned sessionId for all reads, edits, diagnostics, and publishing in this thread; do not create a new session for each operation.",
      "If the session expires after a server restart, call framer_session_new with {} again.",
      "Only request another project's URL/key if the user explicitly asks to work on a different project.",
    ].join("\n")
  : [
      "Framer project setup (one project per thread):",
      "Check configured server-side defaults before asking the user for any credential.",
      hasDefaultProject
        ? "FRAMER_PROJECT_URL is configured; do not ask for the project URL. Ask only for an API key if FRAMER_API_KEY is absent."
        : "FRAMER_PROJECT_URL is not configured; ask for the Framer project URL/ID if the user has not supplied it.",
      hasDefaultApiKey
        ? "FRAMER_API_KEY is configured; do not ask for the API key."
        : "FRAMER_API_KEY is not configured; ask for the project's API key only if it is needed.",
      "Use the configured defaults and any user-provided project details to fill only the missing values.",
      "Authorize with framer_project_auth, then pass its one-use authHandle to framer_session_new. Reuse the returned sessionId for later operations.",
      "The authHandle expires after 15 minutes and is one-use. If the server restarts, create a fresh session.",
    ].join("\n");

const AUTH_EXAMPLE = JSON.stringify(
  {
    projectUrlOrId: "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123",
    projectApiKey: "PASTE_THIS_PROJECTS_API_KEY",
  },
  null,
  2
);
const SESSION_EXAMPLE = JSON.stringify(
  { authHandle: "PASTE_AUTH_HANDLE_RETURNED_BY_FRAMER_PROJECT_AUTH" },
  null,
  2
);

const toolDefinitions = [
  {
    name: "framer_setup_guide",
    title: "Show per-project setup guide",
    description: "Read the server-aware setup guide before asking for credentials. It detects whether FRAMER_PROJECT_URL and FRAMER_API_KEY are configured; when both exist, call framer_session_new with {} directly and do not ask the user to repeat either secret.",
    schema: z.object({}).strict(),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => `${SETUP_GUIDE}\n\nframer_project_auth example:\n${AUTH_EXAMPLE}\n\nframer_session_new example (use the returned authHandle):\n${SESSION_EXAMPLE}`,
  },
  {
    name: "framer_project_auth",
    title: "Authorize a Framer project",
    description: "STEP 1 for a project thread. Authorize the project with its own API key (Site Settings → General → API Keys). This saves the credential in the CLI's private state and returns a random one-use authHandle valid for 15 minutes. Pass that handle to framer_session_new; subsequent tools use the random sessionId capability, so the raw key need not be repeated. Example: {\"projectUrlOrId\": \"https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123\", \"projectApiKey\": \"PASTE_THIS_PROJECTS_API_KEY\"}.",
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
      const authHandle = issueProjectAuthHandle(projectRef);
      return JSON.stringify({
        project: projectRef,
        authorization: output || `Project ${projectRef} authorized.`,
        authHandle,
        expiresInSeconds: Math.floor(AUTH_HANDLE_TTL_MS / 1000),
      });
    },
  },
  {
    name: "framer_session_new",
    title: "Create Framer agent session",
    description: "Create one reusable Framer session. If server-side FRAMER_PROJECT_URL and FRAMER_API_KEY are configured, call this tool with empty arguments {}: the server will use those defaults, so do not ask the user to provide either secret. Otherwise use configured defaults for any supplied values and pass an authHandle or only the missing project details. Reuse the returned project-bound sessionId for all operations in this thread.",
    schema: z.object({
      projectUrlOrId: z.string().min(1).max(500).optional(),
      projectApiKey: z.string().min(8).max(500).optional(),
      authHandle: z.string().min(40).max(128).optional(),
    }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        projectUrlOrId: { type: "string", minLength: 1, maxLength: 500, description: "This thread's Framer project URL or project ID; defaults to FRAMER_PROJECT_URL if configured. If the user has not authorized this project yet, guide them with framer_setup_guide first." },
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "Optional inline key for this project; use authHandle instead to avoid repeating the raw key." },
        authHandle: { type: "string", minLength: 40, maxLength: 128, description: "One-use, short-lived handle returned by framer_project_auth. It is bound to one project and expires in 15 minutes." },
      },
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey, authHandle }) => {
      const keyInput = projectApiKey ?? defaultApiKey();
      const projectRef = authHandle
        ? consumeProjectAuthHandle(authHandle, projectUrlOrId)
        : validateProjectRef(projectUrlOrId || process.env.FRAMER_PROJECT_URL);
      if (!keyInput && !authHandle) {
        throw new Error(`${SETUP_GUIDE}\n\nPass the projectApiKey to framer_project_auth, then provide its authHandle here.`);
      }
      const output = await executeFramer(projectRef, keyInput, ["session", "new", projectRef], CLI_TIMEOUT_MS, { useSavedAuth: Boolean(authHandle) });
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
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "Optional key to reauthorize this project; after session creation, the random sessionId capability is sufficient." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        code: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS, description: "JavaScript code to execute through the Framer agent." },
      },
      required: ["sessionId", "code"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey, sessionId, code }) => {
      const projectRef = projectRefForSession(sessionId, projectUrlOrId);
      return executeFramer(projectRef, projectApiKey ?? defaultApiKey(), ["exec", "--session", resolveSessionId(sessionId), "--eval", code], CLI_TIMEOUT_MS, { useSavedAuth: true });
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
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "Optional key to reauthorize this project; after session creation, the random sessionId capability is sufficient." },
        sessionId: { type: "string", minLength: 8, maxLength: 160 },
        dsl: { type: "string", minLength: 1, maxLength: MAX_CODE_CHARS },
        pagePath: { type: "string", minLength: 1, maxLength: 2048, description: "Target page path; defaults to '/'." },
      },
      required: ["sessionId", "dsl"],
      additionalProperties: false,
    },
    run: async ({ projectUrlOrId, projectApiKey, sessionId, dsl, pagePath }) => {
      const projectRef = projectRefForSession(sessionId, projectUrlOrId);
      return executeFramer(projectRef, projectApiKey ?? defaultApiKey(), ["apply-changes", "--session", resolveSessionId(sessionId), "--eval", dsl, "--page", pagePath || "/"], CLI_TIMEOUT_MS, { useSavedAuth: true });
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
        projectApiKey: { type: "string", minLength: 8, maxLength: 500, description: "Optional key to reauthorize this project; after session creation, the random sessionId capability is sufficient." },
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
      return executeFramer(projectRef, projectApiKey ?? defaultApiKey(), ["read-project", "--session", resolveSessionId(sessionId), "--queries", JSON.stringify(parsed), "--page", pagePath || "/"], CLI_TIMEOUT_MS, { useSavedAuth: true });
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
      const relaySessionId = getSessionContext(clientSessionId).relayId;
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
