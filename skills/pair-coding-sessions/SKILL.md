---
name: pair-coding-sessions
description: Pair Grok Bot to local Codex or Claude Code (Wingman MCP) with easy pair CLI, tunnel, and session tools.
---

# Pair coding sessions (Wingman)

Use this skill to connect **Grok Bot** to **Codex** or **Claude Code** sessions on the user's machine via **Wingman**.

## When to use

- User wants Grok to read or drive a local Codex thread
- User wants Grok to read or drive a local Claude Code session
- Setting up or re-pairing the MCP bridge
- Debugging mock vs real provider mode

## Prerequisites

- Node 20+
- This repo built/installed (`npm install` in the Wingman checkout)
- For **real** Codex: `codex` on PATH (uses `codex app-server`, **not** `codex mcp-server`)
- For **real** Claude: `@anthropic-ai/claude-agent-sdk` is bundled (no separate install needed)
- A tunnel tool: `cloudflared` or Tailscale Funnel (Grok cannot hit `127.0.0.1`)

## Easy pair (3 steps)

### 1. Start the bridge

```bash
cd <path-to-wingman>
# Mock mode (no agent binary needed)
CODEX_MOCK=1 npm run pair
# or
CLAUDE_MOCK=1 npm run pair

# Real mode
npm run pair
```

Note the printed **token** and local URL (`http://127.0.0.1:3847/mcp`).

Config is written to `~/.wingman/config.json` (legacy `~/.session-bridge/config.json` is still read as a fallback).

### 2. Tunnel localhost

```bash
cloudflared tunnel --url http://127.0.0.1:3847
# or
tailscale funnel 3847
```

Copy the public HTTPS origin and append `/mcp`.

### 3. Register MCP with Grok / Cursor

**AddMcpServer** fields:

| Field | Value |
|-------|--------|
| name | `wingman` |
| url | `https://<tunnel-host>/mcp` |
| Authorization | `Bearer <token>` |

Speak as the user when configuring their accounts; never paste the token into public channels.

## Operate

After pairing, prefer these tools (in order):

1. `list_sessions` — `{ "provider": "codex" }` or `{ "provider": "claude" }` or omit for both
2. `read_transcript` — `{ "provider": "...", "session_id": "...", "limit": 30 }`
3. `send_message` — `{ "provider": "...", "session_id": "...", "text": "..." }`
4. `interrupt` — if a turn is stuck
5. `create_session` — `{ "provider": "...", "cwd": "...", "prompt": "..." }`

### Provider-specific notes

**Codex** uses `codex app-server` JSON-RPC over stdio:
- `thread/list`, `thread/start`, `thread/resume`, `thread/read`
- `turn/start`, `turn/interrupt`

**Claude** uses `@anthropic-ai/claude-agent-sdk`:
- `query()` with `resume` option for sending messages
- `listSessions()`, `getSessionMessages()` for reading
- `query().interrupt()` for interrupting

## Mock vs real

| Provider | Mode | How | Behavior |
|----------|------|-----|----------|
| Codex | Mock | `CODEX_MOCK=1` | In-memory sessions; pair works offline |
| Codex | Real | unset mock, `codex` on PATH | JSON-RPC to `codex app-server` |
| Claude | Mock | `CLAUDE_MOCK=1` | In-memory sessions; pair works offline |
| Claude | Real | unset mock | Agent SDK spawns Claude subprocess |

## Session scope

Wingman manages sessions it creates — it does **not** hijack or attach to:
- Arbitrary `codex` processes you already have running
- Claude Code TTYs you opened in another terminal
- Any interactive shell sessions

If you want Grok to control a session, create it through Wingman's `create_session` tool.

## Safety

- Bridge binds **127.0.0.1** only; always use bearer auth
- Do not commit tokens; `~/.wingman/` (and legacy `~/.session-bridge/`) are local
- Approvals / sandbox still run under the user's agent settings
- Do not scrape credentials or bypass auth to "fix" tunnel issues

## Troubleshooting

- **401/403** — wrong or missing `Authorization: Bearer …`
- **Tunnel 502** — pair process not running or wrong port
- **Codex spawn failed** — install Codex CLI or use `CODEX_MOCK=1`
- **Claude SDK error** — check that `@anthropic-ai/claude-agent-sdk` installed correctly
- **interrupt fails** — no tracked `turnId`; send a message first (Codex real mode)
- **session not found** — use `list_sessions` to find Wingman-managed sessions

## Reference links

- https://learn.chatgpt.com/docs/app-server
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/sessions
