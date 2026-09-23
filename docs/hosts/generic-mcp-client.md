# Generic MCP Client Checklist

This guide helps you connect **any MCP-compatible client** to Wingman. Use it as a requirements checklist when evaluating whether your client can pair with Wingman.

## Wingman's MCP Model

Wingman exposes a **remote HTTP MCP endpoint** with bearer token authentication:

```
POST https://YOUR-TUNNEL-URL/mcp
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
```

This is different from local stdio-based MCP servers. Your client must support this model.

## Requirements Checklist

### Required

| Requirement | Details |
|-------------|---------|
| ✅ HTTP MCP support | Client must be able to call remote HTTP endpoints, not just spawn local processes |
| ✅ Custom headers | Client must support setting `Authorization: Bearer <token>` header |
| ✅ JSON-RPC over HTTP | Standard MCP protocol over HTTP POST |

### Recommended

| Requirement | Details |
|-------------|---------|
| ⭐ Configurable timeouts | Long model turns (1-3+ minutes for Claude cold starts) need extended timeouts |
| ⭐ Tool discovery | Client should call `tools/list` to discover available tools |
| ⭐ Error handling | Handle 401 (auth), 502 (tunnel down), and timeout gracefully |

## Connection Details

### Endpoint

```
POST https://YOUR-TUNNEL-URL/mcp
```

Replace `YOUR-TUNNEL-URL` with your actual tunnel address (e.g., `abc123.trycloudflare.com`).

### Headers

```http
Authorization: Bearer YOUR_TOKEN_HERE
Content-Type: application/json
Accept: application/json
```

### Health Check

```
GET https://YOUR-TUNNEL-URL/healthz
```

Returns `{"ok":true,"service":"wingman"}` when Wingman is running.

> **Note**: By default, `/healthz` requires bearer auth. Set `WINGMAN_HEALTHZ_AUTH_FREE=1` to allow unauthenticated health checks (useful for load balancers and monitors).

## Protocol: JSON-RPC 2.0

Wingman uses standard MCP protocol (JSON-RPC 2.0). Example request/response:

### List Tools

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "list_sessions",
        "description": "List active coding sessions",
        "inputSchema": { ... }
      },
      ...
    ]
  }
}
```

### Call Tool

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_sessions",
    "arguments": {
      "provider": "claude"
    }
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"sessions\":[...]}"
      }
    ]
  }
}
```

## Available Tools

| Tool | Required Args | Optional Args | Description |
|------|---------------|---------------|-------------|
| `list_sessions` | — | `provider` | List sessions (both providers if omitted) |
| `get_session` | `provider`, `session_id` | — | Get session details and status |
| `read_transcript` | `provider`, `session_id` | `limit` | Read recent messages |
| `send_message` | `provider`, `session_id`, `text` | — | Send message to session |
| `interrupt` | `provider`, `session_id` | — | Interrupt active turn |
| `create_session` | `provider` | `cwd`, `prompt`, `name`, `tags` | Create new session |
| `wait_turn` | `provider`, `session_id` | `timeout_ms`, `poll_interval_ms` | Wait for turn completion |
| `steer` | `provider`, `session_id`, `text` | — | Add mid-turn guidance (Codex only) |
| `list_approvals` | `provider`, `session_id` | — | List pending approvals (Codex only) |
| `resolve_approval` | `provider`, `session_id`, `approval_id`, `decision` | — | Resolve approval (Codex only) |
| `set_session_meta` | `provider`, `session_id` | `name`, `tags` | Update session metadata |

### Provider Values

- `"codex"` — OpenAI Codex via app-server
- `"claude"` — Anthropic Claude Code via Agent SDK

## Timeout Recommendations

| Operation | Recommended Timeout |
|-----------|---------------------|
| `list_sessions` | 10s |
| `read_transcript` | 10s |
| `send_message` | 30s (returns quickly; turn runs async for Claude) |
| `create_session` | 30s |
| `wait_turn` | 180s (Claude cold starts can take 1-3 minutes) |
| Health check | 5s |

## Error Responses

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 401 | Invalid or missing token | Check Authorization header |
| 404 | Unknown endpoint | Verify URL ends with `/mcp` |
| 502 | Tunnel up but Wingman down | Restart Wingman |
| 504 | Timeout | Increase client timeout; use `wait_turn` for long operations |

## Testing Your Integration

### 1. Health Check

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://YOUR-TUNNEL-URL/healthz
```

Expected: `{"ok":true,"service":"wingman"}`

### 2. List Tools

```bash
curl -X POST https://YOUR-TUNNEL-URL/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 3. List Sessions

```bash
curl -X POST https://YOUR-TUNNEL-URL/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}'
```

## Client Compatibility Matrix

| Client Type | HTTP MCP | Custom Headers | Wingman Compatible |
|-------------|----------|----------------|-------------------|
| Remote MCP hosts (Grok Bot, etc.) | ✅ | ✅ | ✅ Yes |
| Cursor IDE | ✅ | ✅ | ✅ Yes |
| Claude Desktop | ❌ (stdio) | N/A | ⚠️ Needs bridge |
| Custom HTTP clients | ✅ | ✅ | ✅ Yes |
| Local stdio MCP clients | ❌ | N/A | ⚠️ Needs bridge |

## Related Guides

- [Cursor IDE](cursor-ide.md) — Step-by-step for Cursor
- [Claude Desktop](claude-desktop.md) — Workarounds for stdio-only clients
- [Remote Hosts](remote-hosts.md) — Grok Bot and cloud agents
