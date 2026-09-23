# Contributing to session-bridge

Thanks for helping build an open bridge between assistant hosts (Grok Bot, Cursor, and friends) and local coding-agent sessions (Codex first, Claude Code next).

## Ways to help

- Fix bugs or improve the Codex app-server client
- Flesh out the Claude Code provider (Agent SDK / Channels)
- Improve pairing UX (tunnel helpers, installers, docs)
- Add tests, types, and CI
- Write guides for other MCP hosts

## Dev setup

```bash
npm install
npm test
npm run build
CODEX_MOCK=1 npm run pair
```

Node 20+ required. Mock mode needs no Codex CLI.

## Pull requests

1. Fork and branch from `main`
2. Keep changes focused; include tests when behavior changes
3. Run `npm test` and `npm run build` before opening a PR
4. Describe what changed and how you verified it

## Design principles

- **Shared backend, two clients** — do not claim TTY hijack of arbitrary interactive sessions
- **Easy pair** — one local command + tunnel + remote MCP URL
- **Bearer auth** — never ship default open endpoints
- **Honest limits** — document can/can't clearly

## Code of conduct

Be respectful. Harassment and bad-faith spam are not welcome. Maintainers may close PRs/issues that violate that bar.
