# Framer Tool Reference

Read this before executing Framer work through `framer-cli-mcp`.

## Session Lifecycle

- Call `framer_project_auth` once per project thread with that thread's project URL/ID and project API key; it returns a random, one-use `authHandle` valid for 15 minutes.
- Pass `authHandle` to `framer_session_new` once. Reuse the returned random `sessionId` for later tool calls; session-bound calls can omit both `projectApiKey` and `projectUrlOrId`.
- Do not create replacement sessions for follow-ups; a new session can lose state or create another branch when auto-branching is enabled.
- Call `framer_session_destroy` only when the thread's Framer work is complete.
- The handle and session mapping live in the hosted process memory. If Render restarts, reauthorize and create a new session.

## Authentication Examples

Authorize once per thread. This mirrors the official `project auth <projectUrlOrId> <apiKey>` flow, where the key comes from that project's Site Settings → General → API Keys.

```json
{
  "projectUrlOrId": "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123",
  "projectApiKey": "PASTE_THIS_PROJECTS_API_KEY"
}
```

The auth call returns an `authHandle`. Pass it to session creation:

```json
{
  "authHandle": "PASTE_AUTH_HANDLE_RETURNED_BY_FRAMER_PROJECT_AUTH"
}
```

Then use only the returned `sessionId` for session-bound calls. It is an unguessable bearer capability, bound to that project; keep it private.

For session creation without an authHandle, pass the project key inline. For a new session after a Render restart, rerun `framer_project_auth` to receive a fresh authHandle:

```json
{
  "projectUrlOrId": "https://framer.com/projects/PASTE_THIS_THREADS_PROJECT_ID--abc123",
  "projectApiKey": "PASTE_THIS_PROJECTS_API_KEY",
  "sessionId": "PASTE_SESSION_ID",
  "code": "console.log(await framer.getProjectInfo())"
}
```

## Method Selection

Prefer agent-level canvas operations over low-level node APIs:

- Use `framer_apply_changes` for page, layout, style, CMS-on-canvas, component, and design-token edits.
- Use live project-tree reads (`framer.agent.getNode`, `getNodes`, `getNodesOfTypes`, `getDescendantsOfTypes`, `getDescendantReferencesOfTypes`, `getRect`, `getScopeNode`, `getGroundNode`, `getParentNode`, `getAncestors`, `serialize`, `serializeNodes`, `paginate`) for inspecting the canvas.
- Use `framer.agent.readComponentControls`, `readIconSetControls`, `readIcons`, `readLayoutTemplateControls`, and `readShaderControls` for controls reads.
- Use `framer.agent.applyChanges` inside `framer_exec` scripts only when the task needs more complex logic than a plain `framer_apply_changes` call.
- Use `framer.agent.publish` for publishing; do not use low-level `publish`, `getDeployments`, or `deploy` for normal agent publishing flows.
- Use generic `framer.*` plugin APIs only for capabilities without a narrower counterpart, such as code files, localization, and redirects.

## Execution Shape

- `framer_exec` accepts JavaScript up to 100,000 characters.
- `state` persists between `framer_exec` calls in the same session; save reusable results instead of repeating slow API calls.
- `console` output is returned; use it for results.
- `require` supports sandboxed Node modules: `fs`, `path`, `url`, `crypto`, `buffer`, `util`, `os`.
- `fs` is sandboxed to cwd, `/tmp`, and `os.tmpdir()`.
- `framer_read_project` requires `queries` as a JSON array string.

Short example:

```js
const info = await framer.getProjectInfo();
state.projectInfo = info;
console.log(info);
```

## Branch Changes

When output contains `[FRAMER_BRANCH_CHANGE]` and you did not switch branches yourself:

- If the branch name follows the default adjective-noun pattern, rename it with a concise task title via `renameBranch`.
- Tell the user the active branch changed and include the `url` value.
