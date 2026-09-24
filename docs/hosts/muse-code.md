# Pairing Wingman with Muse Code

Muse Code supports MCP servers via streamable HTTP transport with bearer authentication. This makes it compatible with Wingman's remote architecture.

## Overview

| Requirement | Status |
|-------------|--------|
| Streamable HTTP MCP | ✅ Supported |
| Bearer authentication | ✅ Supported (via headers) |
| Works with Wingman | ✅ Full support |

## Prerequisites

1. **Wingman running** — `npx wingman-mcp` or `npm run pair` in a Wingman checkout
2. **Tunnel active** — Muse Code cannot reach `127.0.0.1`; you need a public URL
3. **Token ready** — Printed when Wingman starts
4. **Muse Code installed** — See [Muse Code installation docs](https://dev.meta.ai/docs/muse-code/installation/)

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

Muse Code runs in the cloud and cannot reach localhost. Pick a tunnel:

```bash
# Option 1: Tailscale Funnel (stable, public URL)
tailscale funnel 3847

# Option 2: Cloudflare quick tunnel (ephemeral, for testing)
cloudflared tunnel --url http://127.0.0.1:3847

# Option 3: Cloudflare named tunnel (stable, custom domain)
cloudflared tunnel run wingman
```

Copy the public HTTPS URL (e.g., `https://your-tunnel.trycloudflare.com`).

## Step 3: Configure Muse Code

Add Wingman as an MCP server in your Muse Code settings file.

### Settings Location

| Platform | Path |
|----------|------|
| macOS | `~/.config/muse/settings.json` |
| Linux | `~/.config/muse/settings.json` |
| Windows | `%APPDATA%\muse\settings.json` |

### Configuration

Edit your settings file to add the `mcp_servers` section:

```json
{
  "mcp_servers": {
    "wingman": {
      "transport": "streamable_http",
      "url": "https://YOUR-TUNNEL-URL/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      },
      "enabled": true,
      "mode": "optional"
    }
  }
}
```

> **Note on `mode: "optional"`**: This setting allows Muse Code to continue operating normally if Wingman is unavailable. Muse will display a warning but won't block startup. Use `"required"` only if you need guaranteed Wingman connectivity.

### Alternative: Legacy mcpServers Format

Older Muse Code versions (pre-1.0) may use `mcpServers` instead of `mcp_servers`:

```json
{
  "mcpServers": {
    "wingman": {
      "transport": "streamable_http",
      "url": "https://YOUR-TUNNEL-URL/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

Check your Muse Code version and [configuration docs](https://dev.meta.ai/docs/muse-code/configuration/) for the correct format.

## Step 4: Verify Connection

Restart Muse Code or reload MCP servers, then test connectivity:

1. Open Muse Code command palette
2. Run `/mcp` to see the MCP inventory
3. Verify `wingman` appears with tools listed

Or ask Muse to list sessions:

```
List my Wingman sessions
```

Muse should invoke `list_sessions` and return results.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Cloud                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                      Muse Code                       │   │
│  │                   (MCP Host)                         │   │
│  └───────────────────────┬─────────────────────────────┘   │
│                          │                                  │
│                   HTTPS + Bearer                            │
└──────────────────────────│──────────────────────────────────┘
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

## Available Tools

Once connected, Muse can use these Wingman MCP tools:

| Tool | Purpose |
|------|---------|
| `list_sessions` | List active Codex/Claude sessions |
| `get_session` | Get session details and status |
| `read_transcript` | Read recent messages from a session |
| `send_message` | Send a message to a session |
| `interrupt` | Stop an in-progress turn |
| `create_session` | Start a new Codex/Claude session |
| `wait_turn` | Wait for a turn to complete |
| `steer` | Add mid-turn guidance (Codex only) |
| `list_approvals` | List pending approvals (Codex only) |
| `resolve_approval` | Resolve a pending approval (Codex only) |
| `set_session_meta` | Set session name/tags |
| `export_transcript` | Export transcript as Markdown/JSON |

See the main [README](../../README.md) for full tool documentation.

## Example Workflow

### 1. Create a Codex session

```
Create a new Codex session in /path/to/project with prompt "Set up a basic Express server"
```

### 2. Check progress

```
Read the transcript from that session
```

### 3. Wait for completion

```
Wait for the turn to complete (timeout 2 minutes)
```

### 4. Add guidance

```
Send a message: "Also add TypeScript support"
```

### 5. Interrupt if needed

```
Interrupt the current turn
```

## Multi-Host Scenarios

Wingman enables scenarios where different people use different hosts:

| User | Host | Backend (via Wingman) |
|------|------|----------------------|
| Alice | **Muse Code only** | Codex, Claude Code |
| Bob | **Grok Bot only** | Codex, Claude Code |
| Carol | **Both** | Same Wingman instance |

All hosts connect to the same Wingman tunnel, sharing access to local Codex and Claude Code sessions.

### Muse + Grok on Same Wingman

Both Muse Code and Grok Bot can share a single Wingman pair:

1. Start Wingman once: `npx wingman-mcp`
2. Create one tunnel: `tailscale funnel 3847`
3. Register the same URL + token in both:
   - Muse Code's `~/.config/muse/settings.json`
   - Grok Bot's MCP server settings
4. Both hosts now see the same sessions

## Honest Limits

### MCP Tools Not Sandboxed

Muse Code does not sandbox MCP tool calls. Tools like `send_message` or `create_session` execute with full local permissions. Be careful with:

- Prompts that could trigger destructive commands
- Secrets in chat (they may be sent to sessions)
- Approvals — review carefully before accepting

### Session Messaging vs Wingman

Muse Code has built-in "session messaging" for communication between Muse instances. This is:

- **Muse-to-Muse only** — not cross-product
- **Same user** — cannot share across team members
- **macOS/Linux only** — not Windows-friendly

**Wingman is the cross-host bridge**. Use Wingman for:

- Cross-product communication (Muse ↔ Grok ↔ Cursor)
- Windows compatibility
- Team collaboration (via shared tunnel)

### Platform Support

| Platform | Wingman + Muse | Muse Session Messaging |
|----------|----------------|------------------------|
| macOS | ✅ | ✅ |
| Linux | ✅ | ✅ |
| Windows | ✅ | ❌ |

## Windows Notes

- Use PowerShell or WSL for tunnel commands
- Cloudflare Tunnel: Download `cloudflared.exe` from [Cloudflare releases](https://github.com/cloudflare/cloudflared/releases)
- Tailscale: Install from [tailscale.com/download](https://tailscale.com/download)
- Path separators: Wingman handles both `/` and `\` in `cwd` arguments

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **MCP server not appearing** | Check `mcp_servers` syntax; restart Muse Code |
| **Connection refused** | Check tunnel is running and URL is correct |
| **401 Unauthorized** | Verify token in Authorization header |
| **502 Bad Gateway** | Wingman may not be running; restart with `npx wingman-mcp` |
| **Timeout errors** | Long model turns are normal; use `wait_turn` with appropriate timeout |
| **`mode: "required"` blocking startup** | Change to `"optional"` or ensure Wingman is running |

## Security Considerations

- Never share your bearer token publicly
- Tokens are generated per-pairing session
- The tunnel URL is public but requires the token for access
- Consider using Tailscale Serve (loopback to your network) for private access
- MCP tools execute with local permissions — review all tool calls

## See Also

- [Remote Hosts (Grok Bot)](remote-hosts.md) — Grok Bot setup
- [Cursor IDE](cursor-ide.md) — Cursor setup
- [Main README](../../README.md) — Full Wingman documentation
- [Muse Code Extending Docs](https://dev.meta.ai/docs/muse-code/extending/) — Official Muse MCP docs
