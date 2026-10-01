# Adding a provider

A **provider** is a coding-agent backend Wingman can drive: Codex and Claude Code today, Muse in mock form. New providers are the most valuable contribution you can make — each one brings Wingman to a new group of users.

If you want to add one, [open an issue](https://github.com/juangurdian/wingman/issues/new/choose) first with the agent's name and how it exposes sessions (SDK, JSON-RPC server, HTTP API). We'll help you scope it before you write code.

## What a provider must do

Implement `SessionProvider` from [`src/providers/types.ts`](../src/providers/types.ts).

| Method | Required | Purpose |
|--------|----------|---------|
| `listSessions()` | yes | Sessions the host can see |
| `readTranscript(id, limit?)` | yes | Recent messages, oldest first, newest last |
| `sendMessage(id, text)` | yes | Start a turn; return `accepted` quickly and run the turn in the background |
| `interrupt(id)` | yes | Stop the in-flight turn |
| `getSession(id)` | recommended | Status (`idle` / `running`), active turn, pending approvals |
| `createSession(opts)` | recommended | New session with optional `cwd`, `prompt`, `name`, `tags` |
| `waitTurn(id, opts)` | recommended | Long-poll until the turn ends or blocks on approvals |
| `listApprovals` / `resolveApproval` | if the agent asks permission | Surface permission requests to the host |
| `steer(id, text)` | optional | Mid-turn guidance, if the agent supports it |
| `setSessionMeta(id, meta)` | optional | Names and tags |

## Steps

1. **Write the provider** in `src/providers/<name>.ts`. Use [`claude.ts`](../src/providers/claude.ts) (SDK-based, approvals via callback) or [`codex.ts`](../src/providers/codex.ts) (JSON-RPC subprocess) as a model.
2. **Add a mock mode** behind `<NAME>_MOCK=1` with in-memory sessions. Tests, CI, and first-time users all depend on it; keep it close to the real behavior (async turns, approvals for `sudo` / `rm -rf`).
3. **Register it**:
   - add the name to `ProviderName` in `src/providers/types.ts`
   - add it to `ProviderSchema` in `src/mcp/tools.ts` (the MCP server reuses these schemas)
   - construct it in `createProviders()` in `src/providers/index.ts`
   - add a stub branch in the `list_sessions` handler so a missing binary degrades to a `not_enabled` row instead of an error
4. **Test it**: `tests/<name>-provider.test.ts` for the mock provider, plus a case in `tests/http-server.test.ts` so it is exercised through the real MCP server.
5. **Document it**: a "Real provider modes" entry and environment variables in the README, and doctor checks in `src/doctor.ts` if the agent needs a binary or login.

Run `npm test && npm run build` before opening the PR.

## Design rules

These keep providers consistent for hosts:

- **Official interfaces only.** Use the agent's SDK, server mode, or API. Never attach to a terminal, inject keystrokes, or automate a browser.
- **Never block an MCP request on a model turn.** Return `accepted` and let `waitTurn` do the waiting; tunnels and hosts time out long requests.
- **Never auto-approve.** If the agent asks permission, park the request in `listApprovals` until the host resolves it.
- **Honest limits.** If something isn't supported, return a clear error that says what to do instead.
