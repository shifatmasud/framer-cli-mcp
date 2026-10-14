---
name: framer-cli-mcp
description: Operate Framer websites through the hosted framer-cli-mcp remote MCP server. Use when the user wants to design, edit, analyze, publish, or read data from a Framer project, or asks to authorize a Framer project, create an agent session, execute Framer agent code, apply canvas changes, or destroy a session.
---

# Framer CLI MCP

## Overview

Control Framer projects through the hosted `framer-cli-mcp` remote MCP endpoint. It wraps the official `@framer/agent` CLI on Node 24 and authorizes each thread with that thread's own Framer project API key.

Endpoint: `https://framer-cli-mcp.onrender.com/mcp`
Health: `https://framer-cli-mcp.onrender.com/healthz`
No bearer token is required.

About this server: official `@framer/agent` CLI v0.0.46 on Node 24 in Docker; stateless Streamable HTTP MCP endpoint; per-project API keys (no shared server key); CLI runs as a shell-free subprocess with serialized calls; project credentials live in ephemeral `/tmp` with restrictive permissions; Render Free plan in Singapore (sleeps when idle, filesystem resets on restart); source and skill hosted at `https://github.com/shifatmasud/framer-cli-mcp`; every push to `main` auto-deploys to Render.

## Per-Project Rule

Each thread handles exactly one Framer project.

1. Create a new thread for each project.
2. Ask the user for that thread's project link:
   - Browser: copy the address bar with the project open.
   - App: right-click the project tab, then choose "Copy Project Link".
3. Ask the user for that project's API key from Site Settings → General → API Keys.
4. Call `framer_project_auth` once with that thread's `projectUrlOrId` and `projectApiKey`.
5. Reuse the hosted session for every later task in the same thread.

Never reuse one thread, session, or API key across different Framer projects. If the Render free instance restarts, call `framer_project_auth` again for that thread.

## Workflow

1. Call `framer_setup_guide` and follow its per-project script before asking for credentials.
2. Authorize the thread's project with `framer_project_auth`.
3. Create one session with `framer_session_new` and reuse its session ID for the whole thread.
4. For details on methods, queries, DSL shape, and safety rules, read [Framer tool reference](references/framer-tools.md).
5. For deployment, hosting, environment variables, and troubleshooting, read [hosting reference](references/hosting.md).
6. Destroy the session with `framer_session_destroy` only when the thread's Framer work is finished.

## Authentication Example

Call `framer_project_auth` first in every thread. Replace the placeholders with that thread's project link and that project's key from Site Settings → General → API Keys.

```json
{
  "projectUrlOrId": "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123",
  "projectApiKey": "PASTE_THIS_PROJECTS_API_KEY"
}
```

Expected result: the hosted CLI saves that project's credential (equivalent to `project auth <projectUrlOrId> <apiKey>`), so later calls in the same thread can omit `projectApiKey`. Then create the reusable session:

```json
{
  "projectUrlOrId": "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123"
}
```

## Tool Selection

- `framer_setup_guide`: read the server's per-project setup script first.
- `framer_project_auth`: authorize this thread's project before any other tool.
- `framer_session_new`: create the thread's reusable session.
- `framer_exec`: run JavaScript through the Framer agent when no narrower tool fits.
- `framer_apply_changes`: prefer for page, layout, style, CMS-on-canvas, component, and design-token edits.
- `framer_read_project`: query fonts, guides, screenshots, and other supported project data.
- `framer_session_destroy`: close the thread's session when done.

## Safety

- Only act on projects the user is authorized to edit.
- Prefer reads and reviews before edits.
- Confirm before destructive or unpublished changes the user did not explicitly request.
- Never ask for or store API keys outside the tool call that needs them.
