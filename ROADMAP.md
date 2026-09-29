# Wingman Roadmap

## Positioning

Wingman lets **Grok Bot act as a supervisor/manager** with local coding sessions (Codex, Claude Code) as **workers**. It provides the coordination layer for a remote AI assistant to orchestrate, monitor, and direct multiple local coding agents without hijacking their TTYs.

**What it is**: A TypeScript MCP bridge + CLI that lets remote MCP hosts (Grok Bot, Cursor, Muse Code) supervise local coding-agent sessions running on your machine. The supervisor can list workers, read their progress, assign tasks, handle escalations, and coordinate multi-worker efforts - while you still see sessions locally.

**What it isn't**: Wingman is not a replacement for Codex or Claude Code. It does not run the agents itself - it provides a management layer over sessions that run in their native environments. It stays thin: one local binary, bearer auth, and a focused set of MCP tools.

### Hosts vs Providers

- **Hosts**: MCP clients that connect to Wingman (the supervisor) - Grok Bot, Cursor, Muse Code
- **Providers**: Session backends that Wingman manages (the workers) - Codex, Claude Code, Muse

## Roadmap Priorities

### Priority 1: Live Session Message Injection (Top Goal)

**Goal**: When the user has a Claude Code or Codex chat open (ChatGPT desktop app, Codex TUI, or Claude Code terminal), messages sent through Wingman should appear LIVE in that same open chat, as if the user typed them, with the reply streaming there too.

| Feature | Status | Notes |
|---------|--------|-------|
| **Claude Code stream-json** | Planned | `claude -p --input-format stream-json` for programmatic input |
| **Claude Code background sessions** | Planned | `claude --bg` + `claude attach` for persistent sessions |
| **Claude Code remote-control** | Planned | `/remote-control` for external control (requires subscription) |
| **Codex TUI daemon mode** | In Progress | TUI can connect to shared daemon when running |
| Codex daemon WebSocket | In Progress | Connect via `~/.codex/app-server-control/app-server-control.sock` |
| turn/start message injection | In Progress | Send `turn/start` to inject message into live thread |
| Read-only thread access | Done | Use `thread/read` without resuming |
| Thread ownership tracking | Done | Track which threads Wingman owns |

**Feasibility Ranking** (see [docs/live-session-injection.md](docs/live-session-injection.md)):
1. Claude Code `--input-format stream-json` (HIGHEST - works for new sessions)
2. Claude Code background sessions (HIGH - persistent supervised sessions)
3. Codex TUI daemon mode (MEDIUM - requires manual daemon setup)
4. Claude Code remote-control (MEDIUM - requires subscription)
5. Codex ChatGPT desktop app (LOW - does NOT use daemon mode)
6. OS-level automation (LAST RESORT - fragile, platform-specific)

**Current Limitation**: The ChatGPT desktop app spawns stdio-based app-servers, not daemon mode. Attaching to its sessions requires manual daemon setup: `codex app-server daemon start`.

See [docs/codex-shared-server.md](docs/codex-shared-server.md) for shared server details.

### Priority 2: Board View

**Goal**: One call returns every worker: name, cwd/project, goal, status, last update, and branch/PR if known.

| Feature | Status | Notes |
|---------|--------|-------|
| `list_sessions` returns all workers | Existing | Returns sessions from all providers with status |
| Session status field | Existing | `idle`, `running`, `active`, `notLoaded` |
| Session name/tags | Existing | `name` and `tags` fields on sessions |
| Git branch in session | Partial | Discovered Claude sessions include `gitBranch` |
| Worker goal field | Planned | Track assigned goal per worker |
| Last activity timestamp | Existing | `updatedAt` field on sessions |
| PR association | Planned | Track branch/PR for worker sessions |
| Unified board endpoint | Planned | Single call aggregating all worker state |

### Priority 3: Assign Work

**Goal**: Create a worker with goal + repo/cwd + branch + definition of done; add `wait_any` for multi-worker coordination.

| Feature | Status | Notes |
|---------|--------|-------|
| `create_session` with cwd/prompt | Existing | Creates session with working directory and initial prompt |
| Session name/tags on create | Existing | `name` and `tags` parameters |
| Model override | Existing | `model` parameter (Codex); uses session/Codex config by default |
| Goal assignment | Planned | Structured goal with definition of done |
| Branch specification | Planned | Specify target branch for worker |
| `wait_turn` per worker | Existing | Wait for single worker turn completion |
| `wait_any` multi-worker | Planned | Wait for any of multiple workers to complete/need attention |

### Priority 4: Escalation Policy

**Goal**: Approvals and questions go to the supervisor first; configurable policy for what must go to the human (merge, deploy, migrations, secrets).

| Feature | Status | Notes |
|---------|--------|-------|
| `list_approvals` | Existing | Codex: full support; Claude: returns empty |
| `resolve_approval` | Existing | Codex: full support; Claude: returns unsupported |
| Supervisor-first routing | Planned | Approvals route to supervisor before human |
| Policy configuration | Planned | Define which actions require human approval |
| Escalation categories | Planned | merge, deploy, migrations, secrets, etc. |
| Human escalation queue | Planned | Queue of items that require human attention |

### Priority 5: Coordination

**Goal**: Track files/branches per worker, relay results between workers, flag conflicts.

| Feature | Status | Notes |
|---------|--------|-------|
| Session cwd tracking | Existing | `cwd` field on sessions |
| Git branch tracking | Partial | Discovered Claude sessions include `gitBranch` |
| File change tracking | Planned | Track which files each worker touches |
| Conflict detection | Planned | Flag when workers touch same files/branches |
| Result relay | Planned | Pass outputs from one worker to another |
| Dependency ordering | Planned | Sequence worker tasks with dependencies |

### Priority 6: Reporting

**Goal**: Digest of what finished, what's blocked, and what needs the human, plus stuck/quiet-worker alerts.

| Feature | Status | Notes |
|---------|--------|-------|
| `export_transcript` | Existing | Export as markdown/JSON to `~/.wingman/exports/` |
| Session status | Existing | `idle`, `running`, `active` status |
| Completion detection | Existing | `wait_turn` returns `completed` status |
| Blocked detection | Partial | Approval-pending turns return in `wait_turn` |
| Digest generation | Planned | Summary of all worker states |
| Stuck worker alerts | Planned | Detect workers with no progress |
| Quiet worker alerts | Planned | Detect workers with no activity |
| Human-attention queue | Planned | Items requiring human review |

### Priority 7: Stable Connectivity and Hygiene

**Goal**: Durable tunnels, token hygiene, secure defaults.

| Feature | Status | Notes |
|---------|--------|-------|
| Tailscale Serve/Funnel | Existing | Documented as preferred option |
| Named Cloudflare tunnels | Existing | `wingman-tunnel` setup helper |
| `wingman-tunnel` CLI | Existing | Ranked recommendations for tunnel setup |
| Bearer token auth | Existing | All MCP endpoints require bearer auth |
| Token in pair logs/banner | **Needs fix** | Redact token from visible output |
| `--reuse-token` default | **Needs fix** | Prefer reusing existing token |
| Health endpoint | Existing | `/healthz` with optional auth-free mode |

## Current MCP Tools

| Tool | Args | Notes |
|------|------|--------|
| `list_sessions` | `provider?` | Lists sessions for one or both providers |
| `get_session` | `provider`, `session_id` | Get detailed session info including status |
| `read_transcript` | `provider`, `session_id`, `limit?` | Recent messages (newest at end) |
| `send_message` | `provider`, `session_id`, `text` | Send message to session |
| `interrupt` | `provider`, `session_id` | Interrupt active turn |
| `create_session` | `provider`, `cwd?`, `prompt?`, `name?`, `tags?`, `model?` | Create new session |
| `wait_turn` | `provider`, `session_id`, `timeout_ms?`, `poll_interval_ms?` | Wait for turn completion |
| `steer` | `provider`, `session_id`, `text` | Add mid-turn guidance (Codex only) |
| `list_approvals` | `provider`, `session_id` | List pending approvals (Codex) |
| `resolve_approval` | `provider`, `session_id`, `approval_id`, `decision` | Resolve approval (Codex) |
| `set_session_meta` | `provider`, `session_id`, `name?`, `tags?` | Update session metadata |
| `export_transcript` | `provider`, `session_id`, `format`, `limit?` | Export transcript |

## Environment Variables

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `WINGMAN_TOKEN` | (generated) | Bearer token for MCP auth |
| `WINGMAN_PORT` | `3847` | MCP server port |
| `WINGMAN_HOST` | `127.0.0.1` | MCP server bind address |
| `WINGMAN_WAIT_TURN_TIMEOUT_MS` | `60000` | Default timeout for `wait_turn` |
| `WINGMAN_WAIT_TURN_POLL_MS` | `500` | Default poll interval for `wait_turn` |
| `WINGMAN_HEALTHZ_AUTH_FREE` | `false` | Allow unauthenticated `/healthz` |
| `WINGMAN_HOST_ID` | hostname | Machine identifier for multi-host setups |
| `WINGMAN_HOST_NAME` | hostname | Human-friendly host name |

### Codex

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_MOCK` | unset | Set to `1` for in-memory mock mode |
| `CODEX_BIN` | `codex` | Path to Codex CLI binary |
| `CODEX_APP_SERVER_ARGS` | `app-server` | Args passed to Codex binary |
| `CODEX_RPC_TIMEOUT_MS` | `60000` | JSON-RPC timeout |
| `WINGMAN_CODEX_MODEL` | unset | Override Codex model (optional) |
| `WINGMAN_CODEX_SOCKET` | unset | Path to existing app-server socket (attach mode) |

### Claude

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_MOCK` | unset | Set to `1` for in-memory mock mode |
| `CLAUDE_DISCOVER` | `1` | Set to `0` to disable session discovery |
| `CLAUDE_DISCOVER_DIRS` | (all) | Colon-separated directories to search |
| `CLAUDE_SEND_TIMEOUT_MS` | `120000` | Timeout for Claude SDK operations |
| `WINGMAN_CLAUDE_STREAM_JSON` | unset | Set to `1` for stream-json mode (programmatic control) |
| `WINGMAN_CLAUDE_PATH` | `claude` | Path to Claude Code executable |

## Non-Goals

Wingman intentionally does **not** do:

- **TTY hijack** - We do not attach to arbitrary terminal processes you started elsewhere
- **Browser automation of claude.ai** - Wingman uses the official Claude Agent SDK
- **Multi-agent IDE** - Wingman is a bridge, not a replacement for your editor
- **Persistent daemon** - Wingman runs when you pair; no system service
- **Secrets management** - Bring your own API keys; Wingman only generates its bearer token
- **Auto-approve sandbox prompts** - Approvals belong to the local agent client
- **Replace Codex/Claude CLI** - Wingman wraps the official SDKs; use CLIs directly for full features

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

Feedback, issues, and PRs welcome - especially around:
- Supervisor/worker coordination patterns
- Shared app-server integration
- Multi-worker conflict detection
- Escalation policy design
