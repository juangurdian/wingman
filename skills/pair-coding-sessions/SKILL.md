---
name: pair-coding-sessions
description: Pair Grok Bot to local Codex (Wingman MCP) with easy pair CLI, tunnel, and session tools.
---

# Pair coding sessions (Wingman)

Use this skill to connect **Grok Bot** to **Codex** sessions on the user’s machine via **Wingman**.

## When to use

- User wants Grok to read or drive a local Codex thread
- Setting up or re-pairing the MCP bridge
- Debugging mock vs real Codex mode

## Prerequisites

- Node 20+
- This repo built/installed (`npm install` in the Wingman checkout)
- For **real** Codex: `codex` on PATH (uses `codex app-server`, **not** `codex mcp-server`)
- A tunnel tool: `cloudflared` or Tailscale Funnel (Grok cannot hit `127.0.0.1`)

## Easy pair (3 steps)

### 1. Start the bridge

```bash
cd <path-to-wingman>
CODEX_MOCK=1 npm run pair          # no codex binary needed
# or real:
# npm run pair
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

1. `list_sessions` — `{ "provider": "codex" }`
2. `read_transcript` — `{ "provider": "codex", "session_id": "...", "limit": 30 }`
3. `send_message` — `{ "provider": "codex", "session_id": "...", "text": "..." }`
4. `interrupt` — if a turn is stuck
5. `create_session` — optional `{ "provider": "codex", "cwd": "...", "prompt": "..." }`

Claude (`provider: "claude"`) returns **not yet enabled** unless explicitly stubbed.

## Mock vs real

| Mode | How | Behavior |
|------|-----|----------|
| Mock | `CODEX_MOCK=1` | In-memory sessions; pair works offline |
| Real | unset mock, `codex` on PATH | JSON-RPC to `codex app-server` (`thread/*`, `turn/*`) |

## Safety

- Bridge binds **127.0.0.1** only; always use bearer auth
- Do not commit tokens; `~/.wingman/` (and legacy `~/.session-bridge/`) are local
- Approvals / sandbox still run under the user’s Codex settings
- Do not scrape credentials or bypass auth to “fix” tunnel issues

## Troubleshooting

- **401/403** — wrong or missing `Authorization: Bearer …`
- **Tunnel 502** — pair process not running or wrong port
- **Codex spawn failed** — install Codex CLI or use `CODEX_MOCK=1`
- **interrupt fails** — no tracked `turnId`; send a message first (real mode)

## Reference links

- https://learn.chatgpt.com/docs/app-server
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
