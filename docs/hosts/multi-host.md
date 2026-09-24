# Multi-Host Setup Guide

Run Wingman on multiple machines and connect them to a shared MCP client (like Grok Bot or Cursor Cloud). This guide covers naming hosts, adding multiple remote MCP connectors, and future mesh/gateway plans.

## Overview

When you run Wingman on multiple machines (e.g., a Windows desktop and a Mac laptop), you need a way to tell sessions apart. Wingman now includes **host identity** fields that are returned with every session, so MCP clients can distinguish which machine a session belongs to.

```
┌─────────────────┐    ┌─────────────────┐
│  Pearlwolf      │    │  MacBook Pro    │
│  (Windows)      │    │  (Mac)          │
│                 │    │                 │
│  ┌───────────┐  │    │  ┌───────────┐  │
│  │ Wingman   │  │    │  │ Wingman   │  │
│  │ :3847     │  │    │  │ :3847     │  │
│  └─────┬─────┘  │    │  └─────┬─────┘  │
└────────┼────────┘    └────────┼────────┘
         │                      │
    Tunnel (HTTPS)         Tunnel (HTTPS)
         │                      │
         ▼                      ▼
┌────────────────────────────────────────┐
│          MCP Client (Grok Bot)         │
│                                        │
│  • wingman (Pearlwolf/Windows)         │
│  • wingman-mac (MacBook Pro)           │
└────────────────────────────────────────┘
```

## Quick Start

### 1. Set Host Identity on Each Machine

On **Machine 1** (e.g., Pearlwolf Windows):

```bash
export WINGMAN_HOST_ID="pearlwolf"
export WINGMAN_HOST_NAME="Pearlwolf Windows"
npx wingman-mcp
```

On **Machine 2** (e.g., MacBook Pro):

```bash
export WINGMAN_HOST_ID="macbook"
export WINGMAN_HOST_NAME="MacBook Pro"
npx wingman-mcp
```

### 2. Create Tunnels for Each Machine

Each machine needs its own tunnel with a unique URL:

**Machine 1:**
```bash
tailscale funnel 3847
# → https://pearlwolf.ts.net/
```

**Machine 2:**
```bash
tailscale funnel 3847
# → https://macbook.ts.net/
```

### 3. Add Multiple MCP Connectors

In your MCP client (Grok Bot, Cursor, etc.), add one connector per machine:

**Connector 1: wingman** (Pearlwolf)
```json
{
  "name": "wingman",
  "url": "https://pearlwolf.ts.net/mcp",
  "headers": { "Authorization": "Bearer <pearlwolf-token>" }
}
```

**Connector 2: wingman-mac** (MacBook)
```json
{
  "name": "wingman-mac",
  "url": "https://macbook.ts.net/mcp",
  "headers": { "Authorization": "Bearer <macbook-token>" }
}
```

### 4. Identify Sessions by Host

When you call `list_sessions`, each session now includes `hostId` and `hostName`:

```json
{
  "sessions": [
    {
      "id": "thr_abc123",
      "provider": "codex",
      "hostId": "pearlwolf",
      "hostName": "Pearlwolf Windows",
      "preview": "Fix the auth bug",
      "status": "idle"
    },
    {
      "id": "claude_xyz789",
      "provider": "claude",
      "hostId": "macbook",
      "hostName": "MacBook Pro",
      "preview": "Refactor tests",
      "status": "running"
    }
  ]
}
```

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WINGMAN_HOST_ID` | hostname | Machine identifier (e.g., `pearlwolf`, `macbook`) |
| `WINGMAN_HOST_NAME` | hostname or HOST_ID | Human-friendly display name |

### Config File

Host identity is also saved to `~/.wingman/config.json` when you run `wingman-pair`:

```json
{
  "token": "...",
  "host": "127.0.0.1",
  "port": 3847,
  "hostId": "pearlwolf",
  "hostName": "Pearlwolf Windows"
}
```

### Doctor Check

Run `wingman-doctor` to verify your host configuration:

```
✓ Host identity: hostId="pearlwolf", hostName="Pearlwolf Windows" (from env)
```

## Session Response Fields

All session endpoints now include host identity:

### list_sessions Response

```json
{
  "sessions": [
    {
      "id": "thr_123",
      "provider": "codex",
      "status": "idle",
      "hostId": "pearlwolf",
      "hostName": "Pearlwolf Windows"
    }
  ]
}
```

### get_session Response

```json
{
  "id": "thr_123",
  "provider": "codex",
  "status": "running",
  "activeTurnId": "turn_456",
  "hostId": "pearlwolf",
  "hostName": "Pearlwolf Windows"
}
```

## Example Workflows

### Workflow 1: Dual-Machine Development

You're working on a project with:
- **Windows PC** (Pearlwolf): Running Codex for code generation
- **Mac** (MacBook): Running Claude Code for review/testing

```python
# List all sessions across both machines
sessions = wingman.list_sessions()  # Returns sessions from current connector

# The MCP client can switch connectors to reach different machines
# Sessions include hostId/hostName to identify which machine they're on
```

### Workflow 2: Phone → Any Machine

The original motivation: access any of your dev machines from your phone via Grok Bot.

1. Add both Wingman connectors to Grok Bot
2. When you need to work, pick the machine you want
3. Sessions are tagged with host info, so you always know where you are

## Future: Mesh Gateway (Later)

Currently, you need one MCP connector per machine. A future **mesh gateway** could provide a single connector that fans out to multiple Wingman instances:

```
┌─────────────────────────────────────────────┐
│              Mesh Gateway                   │
│         (Single MCP Connector)              │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Wingman  │  │ Wingman  │  │ Wingman  │  │
│  │ (host 1) │  │ (host 2) │  │ (host 3) │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────┘
```

This is tracked in the [ROADMAP](../../ROADMAP.md) under "Later". For now, use multiple connectors — it works well and is simple to set up.

## Troubleshooting

### Sessions don't show host fields

Check your Wingman version supports host identity (`>=0.2.0`). Run:
```bash
npx wingman-mcp --version
```

### Host shows hostname instead of custom name

Make sure env vars are set before starting Wingman:
```bash
export WINGMAN_HOST_ID="myhost"
export WINGMAN_HOST_NAME="My Host Name"
npx wingman-mcp
```

### Can't connect to both machines

Each machine needs:
1. Its own tunnel with unique URL
2. Its own bearer token (unless you share tokens intentionally)
3. Wingman running on the same port (default 3847)

### Tokens mixed up

Each machine generates its own token in `~/.wingman/config.json`. Copy the correct token for each connector. Run `wingman-doctor` on each machine to see the current config.

## See Also

- [Remote Hosts Guide](remote-hosts.md) — Single-machine tunnel setup
- [Cursor IDE Guide](cursor-ide.md) — Adding MCP connectors in Cursor
- [ROADMAP](../../ROADMAP.md) — Future mesh gateway plans
