# Pairing Wingman with Cursor IDE

Cursor IDE supports remote MCP servers via HTTP URL and custom headers. This makes it a natural fit for Wingman's architecture.

## Overview

| Requirement | Status |
|-------------|--------|
| Remote HTTP MCP | ✅ Supported |
| Bearer authentication | ✅ Supported (via headers) |
| Works with Wingman | ✅ Full support |

## Prerequisites

1. **Wingman running** — `npx wingman-mcp` or `npm run pair` in a Wingman checkout
2. **Tunnel active** — Cursor cannot reach `127.0.0.1`; you need a public URL
3. **Token ready** — Printed when Wingman starts

## Step 1: Start Wingman

```bash
# Quick start (mock mode, no agent binary needed)
CODEX_MOCK=1 npx wingman-mcp

# Or real mode with Codex
npx wingman-mcp

# Or real mode with Claude
npx wingman-mcp
```

Note the printed token and local URL (default: `http://127.0.0.1:3847/mcp`).

## Step 2: Create a Tunnel

Cursor runs in the cloud or on a remote machine and cannot reach your localhost. Pick a tunnel:

```bash
# Option 1: Tailscale Funnel (stable, public URL)
tailscale funnel 3847

# Option 2: Cloudflare quick tunnel (ephemeral, for testing)
cloudflared tunnel --url http://127.0.0.1:3847

# Option 3: Cloudflare named tunnel (stable, custom domain)
cloudflared tunnel run wingman
```

Copy the public HTTPS URL (e.g., `https://your-tunnel.trycloudflare.com`).

## Step 3: Add MCP Server in Cursor

In Cursor, add a new MCP server with these settings:

| Field | Value |
|-------|-------|
| **Name** | `wingman` |
| **URL** | `https://YOUR-TUNNEL-URL/mcp` |
| **Headers** | `Authorization: Bearer YOUR_TOKEN` |

### Using Cursor Settings UI

1. Open Cursor Settings (`Cmd/Ctrl + ,`)
2. Navigate to **Features** → **MCP Servers**
3. Click **Add MCP Server**
4. Enter:
   - **Name**: `wingman`
   - **Type**: Remote (HTTP)
   - **URL**: `https://your-tunnel-url.trycloudflare.com/mcp`
5. Add a custom header:
   - **Key**: `Authorization`
   - **Value**: `Bearer YOUR_TOKEN_HERE`

### Using `.cursor/mcp.json` (per-project)

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "wingman": {
      "url": "https://YOUR-TUNNEL-URL/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

> **Security**: Do not commit this file with real tokens. Add `.cursor/mcp.json` to `.gitignore` or use environment variable substitution if your Cursor version supports it.

## Step 4: Verify Connection

Ask Cursor to call a Wingman tool:

```
List my Wingman sessions
```

Cursor should invoke `list_sessions` and return results.

## Available Tools

Once connected, Cursor can use these Wingman MCP tools:

| Tool | Purpose |
|------|---------|
| `list_sessions` | List active Codex/Claude sessions |
| `get_session` | Get session details and status |
| `read_transcript` | Read recent messages from a session |
| `send_message` | Send a message to a session |
| `interrupt` | Stop an in-progress turn |
| `create_session` | Start a new Codex/Claude session |
| `wait_turn` | Wait for a turn to complete |

See the main [README](../../README.md) for full tool documentation.

## Example Workflow

1. **Create a session**:
   ```
   Create a new Claude session in /path/to/project with prompt "Set up a basic Express server"
   ```

2. **Check progress**:
   ```
   Read the transcript from that session
   ```

3. **Add guidance**:
   ```
   Send a message: "Also add TypeScript support"
   ```

4. **Interrupt if needed**:
   ```
   Interrupt the current turn
   ```

## Windows Notes

- Use PowerShell or WSL for tunnel commands
- Cloudflare Tunnel: Download `cloudflared.exe` from [Cloudflare releases](https://github.com/cloudflare/cloudflared/releases)
- Tailscale: Install from [tailscale.com/download](https://tailscale.com/download)
- Path separators: Wingman handles both `/` and `\` in `cwd` arguments

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Connection refused** | Check tunnel is running and URL is correct |
| **401 Unauthorized** | Verify token in Authorization header |
| **502 Bad Gateway** | Wingman may not be running; restart with `npx wingman-mcp` |
| **Tools not appearing** | Refresh MCP servers in Cursor settings |
| **Timeout errors** | Long model turns are normal; use `wait_turn` with appropriate timeout |

## Security Considerations

- Never share your bearer token publicly
- Tokens are generated per-pairing session
- The tunnel URL is public but requires the token for access
- Consider using Tailscale Serve (loopback to your network) for private access
