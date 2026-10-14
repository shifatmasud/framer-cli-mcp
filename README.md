# Framer CLI MCP

A remote Streamable HTTP MCP server that invokes Framer's official `@framer/agent` CLI inside a Node 24 container. Any Framer project can be authorized per thread with its own API key, matching the official `project auth <projectUrlOrId> <apiKey>` model.

## About

- Official `@framer/agent` CLI v0.0.46 on Node 24 (Docker).
- Stateless Streamable HTTP MCP endpoint at `/mcp`; no bearer token required.
- Per-project API keys: each thread authorizes its own Framer project; no shared server key.
- Security: CLI runs as a shell-free subprocess, calls are serialized, output redacts project API keys, credentials live in ephemeral `/tmp` with restrictive permissions.
- Hosting: Render Free web service in Singapore; sleeps when idle and resets `/tmp` on restart.
- Repo: `https://github.com/shifatmasud/framer-cli-mcp`; every push to `main` auto-deploys (`autoDeploy: yes`, trigger: commit).
- Endpoint: `https://framer-cli-mcp.onrender.com/mcp`; health: `https://framer-cli-mcp.onrender.com/healthz`.

## Runtime configuration

Set these in the Render service's environment settings; do not commit them:

- `FRAMER_API_KEY` (optional): a default project API key, only if every call targets one project.
- `FRAMER_PROJECT_URL` (optional): default project URL/ID for tool calls in a single-project setup.
- `PORT`: Render provides this; the image defaults to `10000`.

The MCP endpoint is `https://<service>.onrender.com/mcp`; health is available at `/healthz`. No bearer token is required. Each Framer project key is passed per thread through `framer_project_auth` or the tool's `projectApiKey` argument.

## Per-project setup

Create a new thread for each Framer project, then copy that project's link:

- Browser: copy the address bar when the project is open.
- App: right-click the project tab, then choose "Copy Project Link".

Then authorize that project once in the thread:

- `framer_project_auth` with that thread's `projectUrlOrId` and `projectApiKey` (Site Settings → General → API Keys).
- Later tools in the same thread can omit `projectApiKey`; the hosted CLI reuses the saved project credential.

Example `framer_project_auth` call (replace both placeholders):

```json
{
  "projectUrlOrId": "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123",
  "projectApiKey": "PASTE_THIS_PROJECTS_API_KEY"
}
```

Then create the thread's reusable session:

```json
{
  "projectUrlOrId": "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123"
}
```

Inline-key fallback for any tool (for example after a Render restart):

```json
{
  "projectUrlOrId": "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123",
  "projectApiKey": "PASTE_THIS_PROJECTS_API_KEY",
  "sessionId": "PASTE_SESSION_ID",
  "code": "console.log(await framer.getProjectInfo())"
}
```

## Tools

- `framer_project_auth`: authorize this thread's project with its own API key.
- `framer_session_new`: create a session for a project.
- `framer_exec`: run JavaScript through the Framer agent's generic CLI `exec` command.
- `framer_apply_changes`: apply canvas DSL to a page.
- `framer_read_project`: query supported project data.
- `framer_session_destroy`: destroy a session.

## Agent skill

Usage instructions live in [`skill/framer-cli-mcp/SKILL.md`](skill/framer-cli-mcp/SKILL.md), with deployment details in `skill/framer-cli-mcp/references/hosting.md` and tool guidance in `skill/framer-cli-mcp/references/framer-tools.md`.

The CLI is run as a subprocess, arguments are passed without a shell, tool output redacts the configured Framer API key, and CLI operations are serialized to avoid relay startup races. The project auth file is stored under the container's ephemeral `/tmp` directory with restrictive permissions. Render Free services may sleep after inactivity and lose their local filesystem; on a fresh instance the CLI relay is recreated as needed.

## Local development

```sh
npm ci
FRAMER_API_KEY=your-local-test-key npm start
```

The health route and MCP endpoint have no bearer token. Never put real keys in shell history or commit them.

## Auto-deploy

Render auto-deploy is enabled for this service (`autoDeploy: yes`, trigger: commit, branch: `main`). Every commit pushed to `main` deploys automatically; environment-variable changes trigger a separate deploy. Verify with `/healthz`, then unauthenticated `tools/list` on `/mcp`.
