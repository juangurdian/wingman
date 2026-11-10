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

1. `list_sessions` — `{ "provider": "codex" }` or `{ "provider": "claude" }` or omit for both. Optional `state`: `live`, `past`, or `all`. Live means a Claude inbox pid is still running.
2. `read_transcript` — `{ "provider": "...", "session_id": "...", "limit": 30 }`
3. `send_message` — `{ "provider": "...", "session_id": "...", "text": "..." }`
4. `interrupt` — if a turn is stuck
5. `create_session` — `{ "provider": "...", "cwd": "...", "prompt": "...", "model": "..." }`
6. `wait_turn`: long-poll a Codex or Claude turn. It returns early while an approval is pending.
7. `list_approvals` / `resolve_approval`: Codex and Claude. An unanswered Claude prompt is denied.
8. `steer`: mid-turn guidance. Claude queues it on the headless query Wingman owns.
9. `list_claude_live_sessions` / `send_to_claude_session`: the interactive inbox. A live `send_message` uses that inbox. A second `send_message` during an active Wingman turn is rejected; use `steer` or `interrupt`.

### Multi-host identification

Sessions now include `hostId` and `hostName` fields so MCP clients can tell which machine a session belongs to when multiple Wingman instances are connected.

### Provider-specific notes

**Codex** uses `codex app-server` JSON-RPC over stdio:
- `thread/list`, `thread/start`, `thread/resume`, `thread/read`
- `turn/start`, `turn/interrupt`

**Claude** uses `@anthropic-ai/claude-agent-sdk`:
- `query()` with `resume` and `forkSession: false` to continue the same session id (`fork_session: true` copies it)
- `maxTurns` defaults to 50. Permission prompts go through `canUseTool` to `list_approvals`
- Model is not hardcoded. Omit it to inherit the session model, or set `model` / `WINGMAN_CLAUDE_MODEL`
- `listSessions()`, `getSessionMessages()` for reading
- `query().interrupt()` for interrupting a Wingman-owned headless query
- A headless resume is not shown in an already-open interactive terminal
- **Session discovery**: `list_sessions` can discover existing Claude sessions created via CLI or IDE (not just Wingman sessions)

### Claude session discovery

Sessions include a `source` field: `'wingman'` (created via Wingman) or `'discovered'` (found via SDK). Set `CLAUDE_DISCOVER=0` to disable discovery. This is NOT TTY hijacking — it reads session files on disk, not terminal processes.

## Mock vs real

| Provider | Mode | How | Behavior |
|----------|------|-----|----------|
| Codex | Mock | `CODEX_MOCK=1` | In-memory sessions; pair works offline |
| Codex | Real | unset mock, `codex` on PATH | JSON-RPC to `codex app-server` |
| Claude | Mock | `CLAUDE_MOCK=1` | In-memory sessions + mock discovered sessions |
| Claude | Real | unset mock | Agent SDK spawns Claude subprocess |

### Codex model override

By default, Wingman uses whatever model is configured in `~/.codex/config.toml` or Codex's built-in defaults. Override only when you intentionally need a different model for Wingman sessions:

```bash
export WINGMAN_CODEX_MODEL="your-preferred-model"  # or pass model arg to create_session
```

If session creation fails due to model access, either ensure you have the required API access, or let Codex pick its default by not setting a model override. Run `wingman-doctor` to check for models that may require API access.

### Claude environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_MOCK` | `0` | Enable mock mode with simulated sessions |
| `CLAUDE_DISCOVER` | `1` | Enable session discovery (set `0` to disable) |
| `CLAUDE_DISCOVER_DIRS` | (all) | Directories to search, split on the OS path delimiter (`:` or `;` on Windows) |
| `WINGMAN_CLAUDE_MAX_TURNS` | `50` | Agent turns per Claude query |
| `WINGMAN_CLAUDE_PERMISSION_MODE` | `default` | Permission mode passed to the Agent SDK |
| `WINGMAN_CLAUDE_MODEL` | unset | Optional model override. Unset inherits the session model |
| `WINGMAN_CLAUDE_APPROVAL_TIMEOUT_MS` | `120000` | Deny an unanswered Claude permission prompt |

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

## When the bridge does not answer

`get_bridge_status` only works while Wingman is up. If the call fails, classify it:

- Cloudflare 1033 or HTTP 530: `tunnel_down` (cloudflared is not connected). The machine may be off, or only the tunnel stopped.
- HTTP 502 or 504: `server_down`. The tunnel is up and Wingman is not listening.
- `fetch failed`, DNS failure, or a timeout with no HTTP status: `host_offline`.
- HTTP 401 or 403: Wingman is up and the bearer token was rejected.

On the machine: `wingman-tunnel diagnose --url https://YOUR-TUNNEL-HOST`. See `docs/operations.md`.

## Headless runs, status, and scope

- `start_codex_exec` runs `codex exec` with `--sandbox` (not `--full-auto`). The prompt is written to stdin.
- `run_headless` starts a long Claude turn. The prompt is an SDK string, so PowerShell 5 does not wrap it.
- `get_run` polls status and tails output. `get_status` reports idle, working, awaiting approval, or errored, plus git HEAD and dirty files.
- `stop` interrupts a session or kills a headless run and reports RSS. Shared Codex and Claude processes are not SIGKILLed.
- `WINGMAN_ALLOWED_PATHS` (or `~/.wingman/allowlist.json`) limits which repos a caller can see. Windows paths are split on `;`.
- `wingman-task install` registers a Windows scheduled task that restarts on crash and does not pass `--new-token`.

## Troubleshooting

- **401/403**: wrong or missing `Authorization: Bearer …`
- **Tunnel 502**: pair process not running or wrong port (`server_down`)
- **Cloudflare 1033**: tunnel process is down (`tunnel_down`), which is separate from a Wingman crash
- **Codex spawn failed**: install Codex CLI or use `CODEX_MOCK=1`
- **Claude SDK error**: check that `@anthropic-ai/claude-agent-sdk` installed correctly
- **interrupt fails**: no tracked `turnId`; send a message first (Codex real mode)
- **session not found**: use `list_sessions` to find Wingman-managed sessions. An allowlist also hides sessions outside its roots.

## Reference links

- https://learn.chatgpt.com/docs/app-server
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/sessions
