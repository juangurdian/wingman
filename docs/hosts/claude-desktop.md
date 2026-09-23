# Pairing Wingman with Claude Desktop

Claude Desktop's MCP integration uses a **stdio-based local server model**, not HTTP. This creates compatibility constraints with Wingman's remote HTTP architecture.

## Overview

| Requirement | Status |
|-------------|--------|
| Remote HTTP MCP | ❌ Not natively supported |
| Stdio MCP servers | ✅ Supported |
| Works with Wingman | ⚠️ Limited (requires wrapper) |

## The Challenge

Claude Desktop expects MCP servers to be local processes that communicate via stdio (stdin/stdout JSON-RPC), not remote HTTP endpoints. Wingman is designed as a remote HTTP MCP server with bearer authentication.

**What this means**:
- You cannot directly add Wingman's `https://tunnel-url/mcp` to Claude Desktop's `mcpServers` config
- Claude Desktop's `mcpServers` JSON shape is for local stdio servers, not HTTP URLs

## Workaround: HTTP-to-Stdio Bridge

If you need Claude Desktop to talk to Wingman, you can use an HTTP-to-stdio bridge. This is an **advanced setup** with extra moving parts.

### Option 1: mcp-remote (Community Tool)

The [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) package bridges HTTP MCP servers to stdio:

```json
{
  "mcpServers": {
    "wingman": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR-TUNNEL-URL/mcp",
        "--header",
        "Authorization: Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

> **Note**: `mcp-remote` is a community package. Verify its current status and compatibility before use.

### Option 2: Custom Bridge Script

Create a minimal Node.js script that translates stdio to HTTP:

```javascript
// wingman-bridge.mjs
import { createInterface } from 'readline';

const WINGMAN_URL = process.env.WINGMAN_URL || 'https://YOUR-TUNNEL-URL/mcp';
const WINGMAN_TOKEN = process.env.WINGMAN_TOKEN || 'YOUR_TOKEN_HERE';

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  try {
    const request = JSON.parse(line);
    const response = await fetch(WINGMAN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WINGMAN_TOKEN}`
      },
      body: JSON.stringify(request)
    });
    const result = await response.json();
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
  }
});
```

Then configure Claude Desktop:

```json
{
  "mcpServers": {
    "wingman": {
      "command": "node",
      "args": ["/path/to/wingman-bridge.mjs"],
      "env": {
        "WINGMAN_URL": "https://YOUR-TUNNEL-URL/mcp",
        "WINGMAN_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

## Claude Desktop Configuration Location

The `mcpServers` configuration lives in Claude Desktop's config file:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Example config structure:

```json
{
  "mcpServers": {
    "wingman": {
      "command": "npx",
      "args": ["mcp-remote", "https://your-tunnel/mcp", "--header", "Authorization: Bearer token"]
    }
  }
}
```

## Why Not Native HTTP Support?

Claude Desktop's MCP implementation focuses on local tool execution where:
- The server runs as a child process
- Communication happens over stdio (fast, no network)
- No authentication is needed (local trust)

Wingman's model is different:
- Remote HTTP server behind a tunnel
- Bearer token authentication
- Designed for cloud hosts that can't reach localhost

These are complementary architectures, not incompatible ones — but bridging requires extra infrastructure.

## Alternative: Use Wingman Directly

If your goal is to have Claude interact with Codex sessions, consider:

1. **Claude Code + Wingman**: Claude Code (the CLI/IDE agent) can connect to Wingman directly if it supports remote MCP
2. **Cursor + Wingman**: Cursor natively supports remote HTTP MCP — see [cursor-ide.md](cursor-ide.md)
3. **Other remote hosts**: Grok Bot and similar cloud agents work natively with Wingman — see [remote-hosts.md](remote-hosts.md)

## Limitations Summary

| Feature | Status |
|---------|--------|
| Direct HTTP URL in config | ❌ Not supported |
| Stdio bridge workaround | ⚠️ Works but adds complexity |
| Native Claude Desktop MCP | ✅ Works for local stdio servers |
| Real-time streaming | ❌ Limited by bridge latency |

## Future

If Claude Desktop adds native HTTP MCP support with custom headers, Wingman would work directly. Until then, the stdio bridge approach is the available path.

## Related Guides

- [Cursor IDE](cursor-ide.md) — Full HTTP MCP support
- [Generic MCP Client](generic-mcp-client.md) — Requirements checklist
- [Remote Hosts](remote-hosts.md) — Grok Bot and cloud agents
