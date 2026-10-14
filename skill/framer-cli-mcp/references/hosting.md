# Hosting Reference

Read this when deploying, redeploying, configuring, or troubleshooting the hosted MCP server.

## Service

- Repository: `https://github.com/shifatmasud/framer-cli-mcp`
- Render service: `framer-cli-mcp` in My Workspace
- Region: Singapore
- Runtime: Docker, Free plan, Node 24
- MCP endpoint: `https://framer-cli-mcp.onrender.com/mcp`
- Health: `https://framer-cli-mcp.onrender.com/healthz`
- No bearer token is required.

## Configuration

Set in Render environment settings; never commit secrets:

- `FRAMER_API_KEY` (optional): default project key for single-project setups.
- `FRAMER_PROJECT_URL` (optional): default project URL/ID for single-project setups.
- `PORT`: provided by Render; the image defaults to `10000`.

The normal multi-project flow passes each thread's project key through `framer_project_auth` or the tool's `projectApiKey` argument.

## Deploy Flow

- Pushes to `main` auto-deploy the Render service.
- Environment-variable changes trigger a separate deploy.
- Verify with `/healthz`, then unauthenticated `tools/list` on `/mcp`.
- Expected tools: `framer_project_auth`, `framer_session_new`, `framer_exec`, `framer_apply_changes`, `framer_read_project`, `framer_session_destroy`.

## Limits

- Render Free services sleep after inactivity and lose local `/tmp` state.
- After a restart, the CLI relay is recreated as needed.
- Users must call `framer_project_auth` again for that thread after a restart.
- CLI calls are serialized server-side to avoid relay startup races.
- Tool output redacts project API keys.
