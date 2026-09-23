# Remote MCP Hosts (Grok Bot & Others)

Wingman is designed primarily for **remote MCP hosts** — cloud-based AI assistants that need to interact with coding agents running on your local machine. This guide covers Grok Bot and similar remote hosts.

## Overview

Remote MCP hosts are cloud services that:
- Cannot directly reach your `127.0.0.1`
- Support adding custom MCP servers via URL + authentication
- Use HTTP JSON-RPC to call MCP tools

Wingman bridges this gap: you run it locally, expose it via a tunnel, and the remote host connects using bearer authentication.

## Supported Remote Hosts

| Host | HTTP MCP | Bearer Auth | Status |
|------|----------|-------------|--------|
| **Grok Bot** | ✅ | ✅ | ✅ Full support |
| **Cursor Cloud Agents** | ✅ | ✅ | ✅ Full support |
| **Custom MCP hosts** | ✅ | ✅ | ✅ If HTTP + headers supported |

## Grok Bot Setup

Grok Bot is the primary use case Wingman was built for. Here's the complete setup:

### Step 1: Start Wingman

```bash
# Quick start (recommended for first-time setup)
CODEX_MOCK=1 npx wingman-mcp

# Real mode with Codex
npx wingman-mcp

# Real mode with Claude
npx wingman-mcp
```

Note the printed **token** and local URL.

### Step 2: Create a Tunnel

Grok Bot runs in the cloud and cannot reach localhost. Create a tunnel:

```bash
# Recommended: Tailscale Funnel (stable)
tailscale funnel 3847

# Alternative: Cloudflare quick tunnel (ephemeral)
cloudflared tunnel --url http://127.0.0.1:3847

# Production: Cloudflare named tunnel (permanent domain)
cloudflared tunnel run wingman
```

For detailed tunnel setup, run `wingman-tunnel` or see the main [README](../../README.md#after-pairing).

### Step 3: Register with Grok Bot

Use Grok Bot's MCP server registration (typically `AddMcpServer` or similar):

| Field | Value |
|-------|-------|
| **name** | `wingman` |
| **url** | `https://YOUR-TUNNEL-URL/mcp` |
| **Authorization** | `Bearer YOUR_TOKEN_HERE` |

### Step 4: Use Wingman Tools

Once registered, ask Grok Bot to use Wingman:

```
List my Wingman sessions
```

```
Create a new Claude session in ~/projects/myapp with prompt "Add user authentication"
```

```
Read the transcript from session sess_abc123
```

## Common Workflows

### Pair Programming with Grok

1. Start Wingman + tunnel
2. Register MCP with Grok Bot
3. Ask Grok to create a session:
   ```
   Create a Codex session in /path/to/project
   ```
4. Grok drives the session; you watch locally
5. Intervene via `send_message` or local agent CLI if needed

### Session Discovery

Grok can discover Claude sessions you created outside Wingman:

```
List all my Claude sessions including discovered ones
```

Sessions show `source: "wingman"` or `source: "discovered"` to indicate origin.

### Long-Running Tasks

For tasks that take time (especially Claude cold starts):

```
Create a Claude session with prompt "Refactor the auth module" and wait for it to complete
```

Grok can use `wait_turn` with extended timeouts to avoid MCP HTTP timeouts.

### Approval Workflows (Codex)

Codex may request approvals for sensitive operations:

```
List pending approvals for session thr_123
```

```
Approve the sudo command in approval appr_456
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Cloud                                │
│  ┌─────────────┐                                            │
│  │  Grok Bot   │ ───── HTTPS + Bearer ─────┐                │
│  └─────────────┘                           │                │
│  ┌─────────────┐                           │                │
│  │   Cursor    │ ───── HTTPS + Bearer ─────┤                │
│  │Cloud Agents │                           │                │
│  └─────────────┘                           │                │
└────────────────────────────────────────────│────────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      Your Machine                            │
│                                                              │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│  │   Tunnel    │ ──▶ │   Wingman   │ ──▶ │   Codex     │   │
│  │ (cloudflared│     │   MCP       │     │ app-server  │   │
│  │  tailscale) │     │ :3847/mcp   │     └─────────────┘   │
│  └─────────────┘     │             │                        │
│                      │             │     ┌─────────────┐   │
│                      │             │ ──▶ │ Claude Code │   │
│                      │             │     │  Agent SDK  │   │
│                      └─────────────┘     └─────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Security Best Practices

### Token Handling

- **Never share tokens publicly** — Each pairing generates a unique token
- **Regenerate tokens** — Run `wingman-pair` to get a new token anytime
- **Don't commit tokens** — Keep `~/.wingman/` out of version control

### Tunnel Security

| Tunnel Type | Visibility | Best For |
|-------------|------------|----------|
| Tailscale Serve | Your Tailnet only | Private/team use |
| Tailscale Funnel | Public | Development, demos |
| Cloudflare named | Public (your domain) | Production |
| Cloudflare quick | Public (ephemeral) | Quick tests |

### Network Binding

Wingman binds to `127.0.0.1` by default — it's not directly accessible from other machines. The tunnel is the only path in.

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| **401 Unauthorized** | Wrong/missing token | Check Authorization header value |
| **502 Bad Gateway** | Wingman not running | Start Wingman with `npx wingman-mcp` |
| **Connection timeout** | Tunnel not running | Restart tunnel; check `wingman-tunnel` |
| **No sessions found** | Wrong provider or no sessions | Create a session first; check provider arg |
| **Interrupt failed** | No active turn or not Wingman-owned | Only works for turns started via Wingman |

## Environment Variables

Control Wingman behavior via environment:

```bash
# Change port (default: 3847)
WINGMAN_PORT=4000 npx wingman-mcp

# Use specific token
WINGMAN_TOKEN=my-secret-token npx wingman-mcp

# Mock mode (no real agents)
CODEX_MOCK=1 npx wingman-mcp
CLAUDE_MOCK=1 npx wingman-mcp

# Auth-free health checks (for tunnel monitors)
WINGMAN_HEALTHZ_AUTH_FREE=1 npx wingman-mcp
```

## Related Guides

- [Cursor IDE](cursor-ide.md) — Desktop IDE with remote MCP support
- [Claude Desktop](claude-desktop.md) — Limitations and workarounds
- [Generic MCP Client](generic-mcp-client.md) — Protocol details and checklist
- [Main README](../../README.md) — Full documentation
- [Skill: Pair Coding Sessions](../../skills/pair-coding-sessions/SKILL.md) — Step-by-step pairing guide
