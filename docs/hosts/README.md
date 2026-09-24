# Multi-Host Pairing Guides

Connect Wingman to various MCP hosts. Choose your host below.

## Quick Reference

| Host | HTTP MCP | Wingman Support | Guide |
|------|----------|-----------------|-------|
| **Grok Bot** | ✅ Remote | ✅ Full | [remote-hosts.md](remote-hosts.md) |
| **Cursor IDE** | ✅ Remote | ✅ Full | [cursor-ide.md](cursor-ide.md) |
| **Muse Code** | ✅ Remote | ✅ Full | [muse-code.md](muse-code.md) |
| **Claude Desktop** | ❌ Stdio | ⚠️ Limited | [claude-desktop.md](claude-desktop.md) |
| **Custom clients** | Varies | Depends | [generic-mcp-client.md](generic-mcp-client.md) |

## Wingman's Architecture

Wingman is a **remote HTTP MCP server**:

```
Remote Host ──HTTPS + Bearer──▶ Tunnel ──▶ Wingman (:3847/mcp) ──▶ Codex/Claude
```

Hosts that support HTTP MCP with custom headers work natively. Stdio-based clients (like Claude Desktop) require a bridge.

## Guides

### [Remote Hosts (Grok Bot & Others)](remote-hosts.md)

The primary use case. Cloud AI assistants connect to your local Codex/Claude sessions via tunnel.

### [Cursor IDE](cursor-ide.md)

Step-by-step setup for Cursor, which natively supports remote MCP servers with bearer authentication.

### [Muse Code](muse-code.md)

Step-by-step setup for Muse Code, which supports streamable HTTP MCP with bearer authentication. Includes multi-host scenarios (Muse + Grok sharing a Wingman).

### [Claude Desktop](claude-desktop.md)

Honest documentation of limitations. Claude Desktop uses stdio-based MCP, not HTTP. Includes workaround options.

### [Generic MCP Client Checklist](generic-mcp-client.md)

Requirements and protocol details for any MCP-compatible client. Use this to evaluate compatibility.

## Common Setup Pattern

All guides follow the same basic flow:

1. **Start Wingman**: `npx wingman-mcp` (mock mode: `CODEX_MOCK=1` or `CLAUDE_MOCK=1`)
2. **Create tunnel**: `tailscale funnel 3847` or `cloudflared tunnel --url http://127.0.0.1:3847`
3. **Configure host**: Add MCP server with URL + bearer token
4. **Test**: `list_sessions` → `create_session` → `read_transcript`

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| 401 error | Wrong token | Copy token from Wingman startup output |
| 502 error | Wingman not running | Start with `npx wingman-mcp` |
| Connection refused | Tunnel down | Restart tunnel |
| Host can't add HTTP server | Stdio-only host | See [Claude Desktop](claude-desktop.md) workarounds |

## See Also

- [Main README](../../README.md) — Full Wingman documentation
- [ROADMAP](../../ROADMAP.md) — Project roadmap and backlog
- [Pair Coding Skill](../../skills/pair-coding-sessions/SKILL.md) — Agent-friendly pairing guide
