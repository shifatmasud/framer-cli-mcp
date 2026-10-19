# Framer Tool Reference

Read this before executing Framer work through `framer-cli-mcp`.

## Session Lifecycle

- First call `framer_setup_guide` to detect server-side defaults.
- If both `FRAMER_PROJECT_URL` and `FRAMER_API_KEY` are configured, call `framer_session_new` with `{}` directly. Never ask the user to paste the same credentials again.
- If one default is configured, use it and request only the missing value.
- If no defaults are configured, call `framer_project_auth` with the project URL and API key, then pass its one-use `authHandle` to `framer_session_new`.
- Reuse the returned `sessionId` for every operation in the thread. Do not create a fresh session for each read or edit.
- If the server restarts and the session map is lost, create a new session. With both defaults configured, call `framer_session_new` with `{}` again.
- Call `framer_session_destroy` only when the thread's Framer work is complete.

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
