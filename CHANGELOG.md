# Changelog

All notable changes to Wingman are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (APIs may still change before 1.0).

## [0.1.0] - Unreleased

First public release.

### Added

- `wingman-pair` / `npx wingman-mcp`: one command generates a bearer token, writes `~/.wingman/config.json`, and starts a Streamable HTTP MCP server on `127.0.0.1:3847/mcp`.
- Providers: Codex (app-server JSON-RPC) and Claude Code (Agent SDK), each with a mock mode; Muse as an experimental mock-only provider.
- MCP tools: `list_sessions`, `get_session`, `read_transcript`, `send_message`, `interrupt`, `create_session`, `wait_turn`, `steer`, `list_approvals`, `resolve_approval`, `set_session_meta`, `export_transcript`.
- Claude approvals: tool calls that need permission pause as approvals that a host resolves with `resolve_approval` (`accept`, `acceptForSession`, `decline`, `cancel`).
- `CLAUDE_PERMISSION_MODE` (`default`, `acceptEdits`, `plan`, `dontAsk`, `auto`) and `CLAUDE_MAX_TURNS` for Wingman-run Claude turns.
- Claude session discovery and resume for sessions started outside Wingman.
- `wait_turn` reports how the last turn ended (including `error` for failed turns) when called after the turn finished; `get_session` includes `pendingApprovals` and `lastError`.
- Session names and tags, multi-host identity (`WINGMAN_HOST_ID` / `WINGMAN_HOST_NAME`), and Codex model override (`WINGMAN_CODEX_MODEL`).
- `wingman-doctor` environment checks and `wingman-tunnel` setup helper.
- Host guides for Grok Bot, Cursor, Muse Code, Claude Desktop, and generic MCP clients; [recipes](docs/recipes.md) and a [provider guide](docs/providers.md).
- CI on Node 20 and 22, HTTP end-to-end tests, and a release workflow that publishes to npm with provenance.

### Fixed

- The MCP server rejected `provider: "claude"` for `wait_turn`, `steer`, `list_approvals`, and `resolve_approval`, and rejected `provider: "muse"` for every tool. Tools now reuse the handler schemas.
- Claude turns stopped after a single API round-trip (`maxTurns: 1`), so multi-step tasks could not finish.
- `interrupt` now aborts the running Claude SDK query, and a finishing turn no longer clears a newer turn's state.
- Failed Claude turns are reported as `failed` with an error instead of `completed`.
- Unfiltered `list_sessions` no longer returns a Muse error row when Muse isn't enabled.
- Bearer tokens are compared in constant time.
- The server reports the package version instead of a hard-coded one.

[0.1.0]: https://github.com/juangurdian/wingman/releases/tag/v0.1.0
