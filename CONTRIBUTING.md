# Contributing to Wingman

Thanks for helping build an open MCP bridge between assistant hosts (Grok Bot, Cursor, and friends) and local coding-agent sessions (Codex and Claude Code).

## Ways to help

- Fix bugs or improve the Codex app-server client
- Improve the Claude Code provider (Agent SDK features, async turn tracking)
- Improve pairing UX (tunnel helpers, installers, docs)
- Add tests, types, and CI
- Write guides for other MCP hosts
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

## Design principles

- **MCP bridge, not orchestrator** — Wingman is a thin radio link, not a multi-agent IDE
- **SDK over TTY** — use official SDKs; never claim TTY hijack of interactive sessions
- **Easy pair** — one local command + tunnel + remote MCP URL
- **Bearer auth** — never ship default open endpoints
- **Honest limits** — document can/can't clearly (see ROADMAP.md non-goals)

## Code of conduct

Be respectful. Harassment and bad-faith spam are not welcome. Maintainers may close PRs/issues that violate that bar.
