# Codex Shared App-Server Investigation

This document describes how Wingman can connect to an existing Codex app-server process (such as the one run by the ChatGPT desktop app) instead of spawning its own.

## Summary

**Yes, attaching to a running app-server is possible.** The Codex app-server exposes a Unix domain socket that accepts multiple concurrent WebSocket connections. External clients can connect, list threads, read transcripts, and send messages - all while the desktop app remains connected.

## Architecture

```
ChatGPT Desktop App
        |
        v
   app-server daemon (process)
        |
        +---> Unix socket: ~/.codex/app-server-control/app-server-control.sock
        |           |
        |           +---> WebSocket connection (Desktop app)
        |           +---> WebSocket connection (Wingman - attach mode)
        |
        +---> ~/.codex/sessions/ (thread storage)
```

## Protocol Details

### Socket Location

The control socket is at:
```
$CODEX_HOME/app-server-control/app-server-control.sock
```

Where `$CODEX_HOME` defaults to `~/.codex`.

### Connection Protocol

1. **Connect** to the Unix socket
2. **HTTP Upgrade** handshake to WebSocket
3. **JSON-RPC messages** (one per WebSocket text frame, without `"jsonrpc":"2.0"` header)

### Initialization Handshake

After WebSocket upgrade, clients must:

1. Send `initialize` request:
```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "wingman",
      "title": "Wingman MCP Bridge",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": true
    }
  }
}
```

2. Receive `initialize` response (contains server info)

3. Send `initialized` notification:
```json
{
  "method": "initialized",
  "params": {}
}
```

### Read-Only Operations

These operations do NOT resume/load a thread:

| Method | Description |
|--------|-------------|
| `thread/list` | Page through stored threads |
| `thread/read` | Read a stored thread by ID |
| `thread/turns/list` | Page through turn history |
| `thread/items/list` | Page through items |
| `thread/loaded/list` | List currently loaded thread IDs |

### Write Operations

These operations DO affect thread state:

| Method | Description | Considerations |
|--------|-------------|----------------|
| `thread/resume` | Load and subscribe to thread | Creates ownership |
| `turn/start` | Send user input | Requires resumed thread |
| `turn/interrupt` | Cancel active turn | Requires active turn |

## Thread Ownership

Important constraint from the protocol:

> Only one app-server process can hold a paginated thread open for writing at a time. If another process already owns the thread, `thread/resume`, `thread/archive`, and `thread/delete` fail with JSON-RPC error `-32600`.

This means:
- Multiple clients CAN connect to the same app-server
- Multiple clients CAN read the same thread
- Only ONE client can have a thread resumed for writing

## Implementation in Wingman

### Attach Mode

Set `WINGMAN_CODEX_SOCKET` to the socket path:
```bash
export WINGMAN_CODEX_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock"
```

Wingman will:
1. Connect to the existing socket instead of spawning `codex app-server`
2. Use read-only operations by default (`thread/list`, `thread/read`)
3. Warn when attempting write operations on threads it does not own

### Read-Only Transcript Access

When reading transcripts for threads Wingman does not own:
- Uses `thread/read` with `includeTurns: true` to read without resuming
- Falls back to `thread/turns/list` + `thread/items/list` for paginated threads
- Never calls `thread/resume` unless explicitly writing

### Safe Send Message

When sending messages:
- If thread appears loaded elsewhere, warn and require `force: true`
- Check `thread/loaded/list` to see if thread is active
- Use `thread.status` from `thread/read` to detect active turns

### Timeout Configuration

The `thread/list` operation can be slow on large session sets. Configuration:
- `CODEX_RPC_TIMEOUT_MS` controls the JSON-RPC timeout (default: 60000ms)
- Retry with exponential backoff on timeout
- Return partial results when available

## What This Enables

1. **Live visibility**: Messages sent through Wingman appear in the desktop app
2. **No duplicate processes**: Single app-server serves both interfaces
3. **Read without interference**: Supervisor can monitor without affecting active work
4. **Safe handoff**: Clear ownership model prevents conflicts

## What This Does NOT Enable

1. **TTY hijack**: Cannot inject keystrokes into terminal processes
2. **Interrupt foreign turns**: Can only interrupt turns Wingman started
3. **Override desktop app**: Desktop app retains priority for its threads

## References

- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex app-server-daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)
- [Codex app-server-client](https://github.com/openai/codex/tree/main/codex-rs/app-server-client)
