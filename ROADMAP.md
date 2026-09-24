# Wingman Roadmap

## Positioning

Wingman is an **MCP radio link** — not a multi-agent IDE, not an orchestrator, not a browser automation tool.

**What it is**: A lightweight TypeScript bridge + CLI that lets remote MCP hosts (Grok Bot, Cursor, Muse Code, etc.) talk to local coding-agent sessions (Codex, Claude Code) running on your machine. You pair once, expose a tunnel, and the remote host can list sessions, read transcripts, send messages, and interrupt turns — while you still see the session locally.

**What it isn't**: Wingman does not attempt to be Omnigent, AgentBridge, or a Claude Orchestrator. It deliberately stays thin: one local binary, bearer auth, and a handful of MCP tools. If you need multi-agent coordination, dynamic tool injection, or browser automation of claude.ai — use those other tools.

### Hosts vs Providers

- **Hosts**: MCP clients that connect to Wingman — Grok Bot, Cursor, Muse Code, etc.
- **Providers**: Session backends that Wingman manages — Codex, Claude Code, and (optionally) Muse sessions

## Why Wingman?

Cloud AI assistants need to collaborate with local agents, but cannot reach `127.0.0.1`. Wingman bridges this gap with:

1. **One-command pairing** — `npm run pair` generates a token, writes config, and starts the MCP server
2. **Simple tunneling** — Works with Cloudflare Tunnel, Tailscale Funnel, ngrok, etc.
3. **Dual-provider support** — Codex (app-server JSON-RPC) and Claude Code (Agent SDK)
4. **Bearer auth** — No open endpoints; your token is the gate
5. **Transparent sessions** — The session stays visible on your machine; Wingman rides shotgun

## Common Use Cases

1. **Remote pair programming** — Grok Bot, Cursor, or Muse Code drives a local Codex/Claude session while you watch and intervene
2. **CI/CD agent handoff** — A cloud agent hands off complex local tasks to a Codex session on a dev machine
3. **Multi-model collaboration** — Use Grok to orchestrate work that Claude Code executes locally
4. **Multi-host collaboration** — Muse users and Grok users share the same Wingman tunnel to collaborate on sessions
5. **Session resume** — Read transcripts from past sessions without retyping context
6. **Headless local agent** — Run Codex/Claude headless on a dev server, control via MCP from anywhere
7. **Live debugging assist** — Cloud assistant reads your local session's error output and suggests fixes
8. **Approval workflows** — Cloud agent sends tasks; you approve locally before execution
9. **Session discovery** — List and resume Claude Code sessions created outside Wingman via SDK discovery

## Backlog

### Now (This Release)

| Feature | Status | Notes |
|---------|--------|-------|
| Async send_message for Claude | ✅ | Returns `accepted` quickly; turn runs in background |
| Async create_session with prompt | ✅ | Returns `accepted` + `turnId` quickly; initial turn runs in background |
| Session status (`get_session`) | ✅ | Track idle vs running, activeTurnId |
| Transcript ordering fix | ✅ | Newest messages at end; regression test |
| `wingman doctor` | ✅ | Node version, config, port, SDK/binary checks, Codex model check, host identity |
| Interrupt hardening | ✅ | Works for Wingman-owned query handles; documented limits |
| Tests | ✅ | Unit tests for all new features |
| ROADMAP + README polish | ✅ | Clear positioning; SDK resume ≠ TTY typing |
| Codex wait/steer/approvals | ✅ | `wait_turn`, `steer`, `list_approvals`, `resolve_approval` tools; mock coverage |
| Claude wait_turn parity | ✅ | `wait_turn` for Claude sessions; soft stubs for steer/approvals with clear errors |
| Codex model override | ✅ | `WINGMAN_CODEX_MODEL` env var + `model` arg on `create_session`; doctor checks for ChatGPT-incompatible models |
| Host identity / multi-host | ✅ | `WINGMAN_HOST_ID`/`WINGMAN_HOST_NAME` config; `hostId`/`hostName` in session responses; [multi-host guide](docs/hosts/multi-host.md) |

### Next

| Feature | Description |
|---------|-------------|
| `npx wingman-mcp` install | ✅ Shipped — run `npx wingman-mcp` or `npm i -g wingman-mcp` |
| Durable tunnel helpers | ✅ Shipped — `wingman-tunnel` CLI with ranked recommendations |
| Session tags/names | ✅ Shipped — `create_session` accepts `name`/`tags`; `set_session_meta` tool for updates |
| Configurable timeouts | ✅ Shipped — `CLAUDE_SEND_TIMEOUT_MS`, `WINGMAN_WAIT_TURN_TIMEOUT_MS`, `WINGMAN_WAIT_TURN_POLL_MS` |
| Health endpoint auth toggle | ✅ Shipped — `WINGMAN_HEALTHZ_AUTH_FREE=1` for monitors/tunnels |

### Later

| Feature | Description |
|---------|-------------|
| Claude Channels / live-visible path | Real-time streaming via SSE when Claude supports it |
| Multi-host guides | ✅ Shipped — see [`docs/hosts/`](docs/hosts/) for Cursor, Muse Code, Claude Desktop (with limitations), generic clients, and [multi-host setup](docs/hosts/multi-host.md) |
| Multi-host mesh gateway | Single MCP connector that fans out to multiple Wingman instances — for now, use multiple connectors (see [multi-host guide](docs/hosts/multi-host.md)) |
| Muse Code host guide | ✅ Shipped — [docs/hosts/muse-code.md](docs/hosts/muse-code.md) |
| Muse provider (MSP) | 🔄 In progress — Muse as a provider via `muse serve` / `@muse-code/sdk` (see below) |
| Named sessions | Human-friendly session names across providers |
| Session export | ✅ Shipped — `export_transcript` tool exports as Markdown/JSON to `~/.wingman/exports/` |
| Web dashboard | Local-only status page for paired sessions |
| Plugin architecture | Provider plugins beyond Codex/Claude |

### Muse Provider Roadmap

The Muse provider enables Grok and Cursor hosts to interact with Muse Code sessions via Wingman.

| Phase | Status | Description |
|-------|--------|-------------|
| Muse as host | ✅ Shipped | Muse Code connects to Wingman to access Codex/Claude sessions |
| Muse provider stub | ✅ Shipped | `MUSE_MOCK=1` mode for testing MCP wiring |
| MSP full integration | 🔜 Next | Real `muse serve` / SDK integration when API stabilizes |

**Note**: The Muse provider does NOT claim TTY hijack of arbitrary Muse TUIs. Like Claude, it manages Wingman-owned / MSP sessions, not interactive terminals.

> **Multi-host guides note**: Claude Desktop support is documented as limited — it uses stdio-based MCP, not HTTP. The guide includes honest documentation of workarounds. Cursor IDE and remote hosts (Grok Bot) have full support.

## Non-Goals

Wingman intentionally does **not** do:

- **TTY hijack** — We do not attach to arbitrary terminal processes you started elsewhere
- **Browser automation of claude.ai** — Wingman uses the official Claude Agent SDK, not browser puppeteering
- **Multi-agent IDE** — Wingman is a bridge, not a replacement for your editor or IDE
- **Persistent daemon** — Wingman runs when you pair; no system service / always-on process
- **Secrets management** — Bring your own API keys; Wingman only generates its bearer token
- **Auto-approve sandbox prompts** — Approvals belong to the local agent client, not the remote host
- **Replace Codex/Claude CLI** — Wingman wraps the official SDKs; use the CLIs directly for full features

## Competitive Landscape

| Tool | Focus | How Wingman Differs |
|------|-------|---------------------|
| **Omnigent / AO / Superset** | Full multi-agent orchestration | Wingman is just the bridge — no orchestration layer |
| **AgentBridge** | Claude↔Codex relay | Wingman adds Grok/Cursor MCP, dual-provider, session discovery |
| **Claude Remote Control** | Browser automation of claude.ai | Wingman uses official SDK; no browser puppeteering |
| **codex-supervisor-mcp** | Codex-only MCP server | Wingman adds Claude, session discovery, richer status |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

Feedback, issues, and PRs welcome — especially around:
- Tunnel helpers and setup automation
- Provider improvements (Codex app-server edge cases, Claude SDK features)
- Guides for other MCP hosts
- Documentation and examples
