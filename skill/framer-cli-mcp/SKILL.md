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

## Project Setup — Server Defaults First

Each thread should work against exactly one Framer project. **Never ask the user to repeat credentials that are already configured server-side.**

1. Call `framer_setup_guide` first.
2. If both `FRAMER_PROJECT_URL` and `FRAMER_API_KEY` are configured, call `framer_session_new` with empty arguments `{}`. Do not ask for the URL or key. Reuse the returned `sessionId` for all reads, edits, diagnostics, and publishing in this thread.
3. If only one server default exists, use it and request only the missing detail.
4. If no defaults exist, ask for the project's URL and API key, call `framer_project_auth`, then pass its one-use `authHandle` to `framer_session_new`.
5. If the user explicitly requests a different project, use that project's credentials rather than the configured defaults.
6. If the hosted server restarts and the session is lost, create a fresh session; with server defaults, call `framer_session_new` with `{}` again.

Keep each session bound to one project. The authHandle expires after 15 minutes and is consumed when creating a session.

## Workflow

1. Call `framer_setup_guide` to detect server-side defaults.
2. If both defaults are configured, call `framer_session_new` with `{}`; otherwise authorize only the missing project details.
3. Reuse one session ID for the entire thread.
4. For details on methods, queries, DSL shape, and safety rules, read [Framer tool reference](references/framer-tools.md).
5. For deployment, hosting, environment variables, and troubleshooting, read [hosting reference](references/hosting.md).
6. Destroy the session with `framer_session_destroy` only when the thread's Framer work is finished.

## Authentication Example

When server-side defaults are configured, the normal flow is simply:

```json
{}
```

Call `framer_session_new` with that empty object. Do not ask the user to paste the configured URL or API key.

Only use the per-project authorization flow when no defaults are configured or the user explicitly asks for a different project. In that case, call `framer_project_auth` with the project URL and API key, then pass the returned `authHandle` to `framer_session_new`. The returned random `sessionId` is the capability for follow-up calls; keep it private.

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
