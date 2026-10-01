# Contributing to Wingman

Thanks for helping build an open MCP bridge between assistant hosts (Grok Bot, Cursor, and friends) and local coding-agent sessions (Codex and Claude Code).

## Ways to help

- **Tell us how you use it.** Post your setup in [Discussions](https://github.com/juangurdian/wingman/discussions) — real use cases decide what gets built next.
- **Add a provider** for another coding agent — see [docs/providers.md](docs/providers.md). This is the most valuable contribution.
- **Pick up a `good first issue`** — [open issues with that label](https://github.com/juangurdian/wingman/labels/good%20first%20issue) are scoped for a first PR.
- Fix bugs or improve the Codex and Claude providers
- Improve pairing UX (tunnel helpers, installers, docs)
- Write guides for other MCP hosts, or [recipes](docs/recipes.md) for new use cases
- Improve the doctor command with more checks

## Dev setup

```bash
npm install
npm run doctor          # Check environment
npm test                # Run tests
npm run build           # Compile TypeScript
CODEX_MOCK=1 npm run pair   # or CLAUDE_MOCK=1
```

Node 20+ required. Mock mode needs no Codex/Claude CLI. Config lives in `~/.wingman/` (legacy `~/.session-bridge/` is still read as a fallback).

## Pull requests

1. Fork and branch from `main`
2. Keep changes focused; include tests when behavior changes
3. Run `npm test` and `npm run build` before opening a PR
4. Describe what changed and how you verified it
5. Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes

New to the codebase? Start at `src/mcp/tools.ts` (the MCP tool handlers) and `src/providers/types.ts` (the provider interface). `tests/http-server.test.ts` shows the whole flow over real HTTP.

## Design principles

- **MCP bridge, not orchestrator** — Wingman is a thin radio link, not a multi-agent IDE
- **SDK over TTY** — use official SDKs; never claim TTY hijack of interactive sessions
- **Easy pair** — one local command + tunnel + remote MCP URL
- **Bearer auth** — never ship default open endpoints
- **Never auto-approve** — permission requests wait for an explicit host decision
- **Honest limits** — document can/can't clearly (see ROADMAP.md non-goals)

## Code of conduct

Everyone taking part in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
