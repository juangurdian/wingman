# Codex Shared App-Server Investigation

> **See also**: [Live Session Message Injection](./live-session-injection.md) for a comprehensive investigation of injecting messages into running Claude Code and Codex sessions.

This document describes the findings from investigating whether Wingman can connect to an existing Codex app-server process.

## Summary

**Partial support.** The Codex app-server protocol does support external clients connecting via a Unix control socket, but the **ChatGPT desktop app does NOT use the control-socket daemon mode**. It spawns its own stdio-based app-servers as child processes, which cannot be attached to externally.

Attach mode works only when:
1. A user manually starts `codex app-server daemon start`, OR
2. A future version of the ChatGPT desktop app adopts daemon mode

## Findings from Real Mac Testing (codex-cli 0.152.1)

### What Exists

| Path | Purpose | Usable by Wingman? |
|------|---------|-------------------|
| `~/.codex/ipc/ipc.sock` | IDE context (VS Code/Cursor extension communication) | **No** - different protocol, no thread access |
| `~/.codex/app-server-control/app-server-control.sock` | App-server control plane | **Yes, when it exists** - but NOT created by ChatGPT app |

### How the ChatGPT Desktop App Works

The ChatGPT desktop app spawns **multiple stdio-based app-servers** as child processes:

```
/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://
/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled ...
```

- Each app-server is a separate child process with stdio transport
- There is **no shared control socket** these can attach to
- Wingman cannot connect to these stdio-based servers externally

### The IPC Socket (`~/.codex/ipc/ipc.sock`)

This socket is for IDE context communication only:
- Protocol: JSON frames with length prefix (not WebSocket)
- Purpose: Fetching open tabs, active file, and selection from VS Code/Cursor
- Method: `ide-context` requests only
- **Cannot**: list threads, send messages, read transcripts, or control turns

## Control Socket Daemon Mode

The app-server daemon mode DOES create a shared control socket:

```bash
# Start the daemon (creates the control socket)
codex app-server daemon start

# Enable remote control for mobile/web access
codex app-server daemon enable-remote-control

# Check status
codex app-server daemon version
```

When running:
- Creates `~/.codex/app-server-control/app-server-control.sock`
- Accepts multiple WebSocket connections
- Supports full thread/turn/message protocol

### Daemon Protocol

When the daemon is running, external clients can connect:

1. **Connect** to the Unix socket via WebSocket HTTP Upgrade
2. **Initialize** with JSON-RPC handshake
3. **Use full API**: `thread/list`, `thread/read`, `turn/start`, etc.

Read-only operations (safe for non-owned threads):
- `thread/list` - list all threads
- `thread/read` - read thread without resuming
- `thread/turns/list` - page through turn history
- `thread/loaded/list` - see which threads are currently loaded

## Wingman Implementation

### Attach Mode

Set `WINGMAN_CODEX_SOCKET` to connect to an existing daemon:

```bash
# Point to the control socket (auto-detected if not set)
export WINGMAN_CODEX_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock"
npm run pair
```

If the socket doesn't exist, Wingman falls back to spawn mode with a clear message.

### Auto-Detection

When `WINGMAN_CODEX_SOCKET` is set to `auto`:
1. Check if `~/.codex/app-server-control/app-server-control.sock` exists
2. If yes: connect to it (attach mode)
3. If no: spawn own app-server (spawn mode) with a note explaining why

### Read-Only Safety (Both Modes)

Wingman now uses read-only operations by default in **both** modes:
- `read_transcript` uses `thread/read` instead of `thread/resume` when possible
- Tracks which threads Wingman owns (created or resumed)
- Warns when `send_message` targets a non-owned thread
- Supports `force` flag to override warnings

## How to Share Sessions with Codex CLI/TUI

To share sessions between Wingman and the Codex CLI/TUI:

```bash
# Terminal 1: Start the daemon
codex app-server daemon start

# Terminal 2: Use Codex TUI (connects to daemon automatically)
codex

# Terminal 3: Start Wingman in attach mode
export WINGMAN_CODEX_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock"
npm run pair
```

Both the TUI and Wingman will see the same threads.

**Note**: The ChatGPT desktop app does NOT use this daemon, so its threads remain inaccessible to Wingman.

## What This Does NOT Enable

1. **Sharing with ChatGPT desktop app** - The app uses stdio-based servers, not the daemon
2. **Attaching to arbitrary processes** - Only the daemon socket is supported
3. **IDE context access** - The IPC socket uses a different protocol

## Protocol References

- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex app-server-daemon README](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)
- [Codex IDE context IPC](https://github.com/openai/codex/blob/main/codex-rs/tui/src/ide_context/ipc.rs)
