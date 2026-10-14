# Framer CLI MCP

A remote Streamable HTTP MCP server that invokes Framer's official `@framer/agent` CLI inside a Node 22 container. It exposes session creation, generic agent code execution, project reads, canvas DSL changes, and session cleanup.

## Runtime configuration

Set these in the Render service's environment settings; do not commit them:

- `MCP_AUTH_TOKEN`: a long random bearer token used by Upsy to authenticate to `/mcp`.
- `FRAMER_API_KEY`: the Framer External Agent API key used by the official CLI.
- `FRAMER_PROJECT_URL` (optional): default project URL/ID for tool calls.
- `PORT`: Render provides this; the image defaults to `10000`.

The MCP endpoint is `https://<service>.onrender.com/mcp`; health is available at `/healthz`. Send `Authorization: Bearer <MCP_AUTH_TOKEN>` on MCP requests. The Framer API key is kept separate from the MCP endpoint token.

## Tools

- `framer_session_new`: create a session for a project.
- `framer_exec`: run JavaScript through the Framer agent's generic CLI `exec` command.
- `framer_apply_changes`: apply canvas DSL to a page.
- `framer_read_project`: query supported project data.
- `framer_session_destroy`: destroy a session.

The CLI is run as a subprocess, arguments are passed without a shell, tool output redacts the configured Framer API key, and CLI operations are serialized to avoid relay startup races. The project auth file is stored under the container's ephemeral `/tmp` directory with restrictive permissions. Render Free services may sleep after inactivity and lose their local filesystem; on a fresh instance the CLI relay is recreated as needed.

## Local development

```sh
npm ci
MCP_AUTH_TOKEN=local-test FRAMER_API_KEY=your-local-test-key npm start
```

The health route is public. MCP requests require the bearer token. Never put real keys in shell history or commit them.
