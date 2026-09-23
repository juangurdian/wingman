# session-bridge

TypeScript **MCP bridge** + easy **pair CLI** so **Grok Bot** can talk to **Codex** (and stub Claude) sessions on a user’s machine.

Codex-first. Claude is stubbed until a stable session API is wired.


## Community

Open-source project. Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.

**Status:** early MVP. Codex path works (mock + app-server). Claude Code is stubbed. APIs may change before 1.0.

## 3-step pair

```bash
cd /workspace/session-bridge   # or your clone/path
npm install
CODEX_MOCK=1 npm run pair
```

1. **Pair** — `CODEX_MOCK=1 npm run pair` generates a bearer token, writes `~/.session-bridge/config.json`, and starts MCP on `127.0.0.1:3847/mcp`.
2. **Tunnel** — Grok Bot cannot reach localhost. Expose the port:

   ```bash
   # Cloudflare quick tunnel
   cloudflared tunnel --url http://127.0.0.1:3847

   # or Tailscale Funnel
   tailscale funnel 3847
   ```

3. **Add MCP server** (tell Grok Bot / Cursor `AddMcpServer`):

   | Field | Value |
   |-------|--------|
   | **name** | `session-bridge` |
   | **url** | `https://YOUR-TUNNEL-HOST/mcp` |
   | **Authorization** | `Bearer <token printed by pair>` |

Then ask Grok Bot to call `list_sessions` → `read_transcript` / `send_message` / `interrupt`.

### Real Codex mode

Requires `codex` on `PATH`. The bridge speaks **Codex app-server** JSON-RPC (`codex app-server` over stdio) — **not** the removed `codex mcp-server`.

```bash
# unset mock
npm run pair
```

Docs: [Codex App Server](https://learn.chatgpt.com/docs/app-server) · [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run pair` | Generate token, save config, start MCP, print pair instructions |
| `npm run dev` | Start MCP only (needs existing config/token) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm test` | Vitest unit tests (mocked providers) |

## Architecture

```mermaid
flowchart LR
  subgraph cloud [Cloud]
    Grok[Grok Bot]
  end
  subgraph user [User machine]
    Tunnel[cloudflared / tailscale]
    Bridge[session-bridge MCP\n127.0.0.1:PORT]
    Codex[Codex app-server\nJSON-RPC stdio]
    Claude[Claude stub]
  end
  Grok -->|HTTPS + Bearer| Tunnel --> Bridge
  Bridge --> Codex
  Bridge -.->|not yet enabled| Claude
```

## MCP tools

| Tool | Args | Notes |
|------|------|--------|
| `list_sessions` | `provider?`: `codex` \| `claude` | Lists sessions (Claude stub marker if disabled) |
| `read_transcript` | `provider`, `session_id`, `limit?` | Recent messages |
| `send_message` | `provider`, `session_id`, `text` | Codex: `turn/start` |
| `interrupt` | `provider`, `session_id` | Codex: `turn/interrupt` (needs known turn id) |
| `create_session` | `provider`, `cwd?`, `prompt?` | Optional; Codex: `thread/start` |

## Can / Can’t

**Can**

- Pair in **mock mode** with no Codex install (`CODEX_MOCK=1`)
- Bridge Grok Bot ↔ local Codex threads via app-server once tunneled
- Bearer-protect the MCP HTTP endpoint
- Create / list / read / message / interrupt Codex sessions (real or mock)

**Can’t (yet)**

- Reach the bridge from Grok without a **tunnel** (binds loopback only)
- Drive full Claude Code session UX (stub / optional `claude -p` oneshot)
- Auto-approve Codex sandbox prompts (approvals still belong to the local Codex client)
- Use legacy `codex mcp-server` (removed / not used here)

## Config

`~/.session-bridge/config.json`:

```json
{
  "token": "...",
  "host": "127.0.0.1",
  "port": 3847,
  "mcpPath": "/mcp",
  "createdAt": "...",
  "mock": true
}
```

Env overrides: `SESSION_BRIDGE_TOKEN`, `SESSION_BRIDGE_PORT`, `SESSION_BRIDGE_HOST`, `CODEX_MOCK`, `CODEX_BIN`, `CODEX_APP_SERVER_ARGS`.

## Agent skill

See [`skills/pair-coding-sessions/SKILL.md`](skills/pair-coding-sessions/SKILL.md) for setup / pair / operate steps aligned with this CLI.

## Develop

```bash
npm install
npm test
npm run build
CODEX_MOCK=1 npm run pair
```

Success criteria: install, test, and build succeed; mock pair prints URL + token.
