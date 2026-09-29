# Live Session Message Injection Investigation

**Goal**: When a user has a Claude Code or Codex chat open, a message Grok Bot sends through Wingman should appear LIVE in that same open chat, as if the user typed it, and the reply should stream there too.

## Feasibility Rankings (Best to Worst)

| Rank | Client | Path | Feasibility | Notes |
|------|--------|------|-------------|-------|
| 1 | Claude Code Terminal | Cross-session inbox socket | **HIGH** | IMPLEMENTED - per-session Unix socket |
| 2 | Claude Code Terminal | `--input-format stream-json` | **HIGH** | Programmatic stdin injection works |
| 3 | Claude Code Terminal | `--bg` + attach | **HIGH** | Background sessions can be controlled |
| 4 | Codex TUI | Shared daemon mode | **MEDIUM** | IMPLEMENTED - requires manual daemon setup |
| 5 | Claude Code Terminal | `--remote-control` | **MEDIUM** | Requires claude.ai subscription |
| 6 | Codex Desktop (ChatGPT) | Manual daemon setup | **LOW** | ChatGPT app doesn't use daemon |
| 7 | Claude Desktop | Unknown IPC | **UNKNOWN** | Needs more investigation |
| 8 | Any | OS-level typing automation | **LAST RESORT** | Fragile, platform-specific |

---

## 1. Claude Code Terminal (Rank 1-4)

### Path A: Stream JSON Input (HIGHEST FEASIBILITY)

Claude Code supports programmatic message injection via `--input-format stream-json`:

```bash
# Start Claude Code with stream-json input
claude -p --input-format stream-json --output-format stream-json
```

Then send JSON messages on stdin:

```json
{"type": "user_message", "content": "Write a hello world program"}
```

**Pros**:
- Works with any Claude Code session
- No special subscriptions required
- Fully programmatic
- Bidirectional streaming

**Cons**:
- Must start session with these flags
- Not for already-running interactive sessions

**Setup Steps**:
1. Start Claude Code: `claude -p --input-format stream-json --output-format stream-json`
2. From Wingman, write JSON to stdin
3. Read responses from stdout

### Path B: Background Sessions (HIGH FEASIBILITY)

```bash
# Start background session
claude --bg "Your initial prompt"
# Returns: session_id

# Later, attach to it
claude attach <session_id>

# Or list all background sessions
claude agents --json
```

**Pros**:
- Sessions persist
- Can programmatically manage multiple sessions
- `claude agents --json` returns session list

**Cons**:
- Attaching opens interactive mode
- Need to investigate if messages can be sent without attaching

### Path C: Remote Control (MEDIUM FEASIBILITY)

```bash
# Start with remote control
claude --remote-control "my-session"
```

**Pros**:
- Designed for external control
- QR code for mobile access
- Named sessions

**Cons**:
- Requires claude.ai subscription
- Need to investigate the control protocol

### Path D: Resume with Injection

```bash
# Resume and add message
claude --resume <session_id> -p "New message to inject"
```

**Cons**:
- May interrupt running sessions
- Not truly "live" injection

---

## 2. Codex TUI (Rank 3)

### Path: Shared Daemon Mode (MEDIUM FEASIBILITY) - CONFIRMED WORKING

**IMPORTANT (v0.152.1+)**: The TUI does NOT auto-connect to the daemon. You must explicitly use `--remote unix://`.

**How it works**:

1. Start the Codex app-server daemon:

   **Option 1** - For managed install (from chatgpt.com/codex/install.sh):
   ```bash
   codex app-server daemon start
   ```

   **Option 2** - For Homebrew/npm install (run manually or via launchd):
   ```bash
   codex app-server --listen unix://
   ```

2. This creates a control socket at:
   ```
   ~/.codex/app-server-control/app-server-control.sock
   ```

3. Connect the TUI to the daemon (REQUIRED):
   ```bash
   codex --remote unix://
   # (plain "codex" does NOT auto-connect in v0.152.1+)
   ```

4. Wingman connects to the same daemon via WebSocket

5. Both see the same threads; Wingman sends `turn/start` with user message

6. **Message appears LIVE in TUI!** Reply streams to both clients.

**Note**: Threads only appear in thread listings after at least one message has been sent.

**Protocol for message injection** (once connected to daemon):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "turn/start",
  "params": {
    "threadId": "the-thread-id",
    "input": [{"type": "text", "text": "Your message here"}]
  }
}
```

**Pros**:
- Real shared session
- Message appears in TUI live
- Reply streams to both clients

**Cons**:
- User must manually start daemon first
- User must explicitly connect TUI with `--remote unix://`
- ChatGPT desktop app does NOT use daemon mode
- Thread ownership: first to `thread/resume` owns it for writing
- `codex app-server daemon start` only works with managed install (chatgpt.com/codex/install.sh)
- For Homebrew/npm installs, must use `codex app-server --listen unix://` instead

**Exact Commands to Test on Mac**:

```bash
# Terminal 1: Start the daemon
# For managed install (chatgpt.com/codex/install.sh):
codex app-server daemon start

# For Homebrew/npm install (if daemon start fails):
codex app-server --listen unix://

# Should create socket at ~/.codex/app-server-control/app-server-control.sock

# Terminal 2: Connect Codex TUI to the daemon
codex --remote unix://
# NOTE: Plain "codex" does NOT auto-connect in v0.152.1!
# Create a new thread and note its ID

# Terminal 3: Run Wingman in attach mode
cd /path/to/wingman
export WINGMAN_CODEX_SOCKET=auto
npm run pair
# Use send_message tool with the thread ID from Terminal 2
# Watch Terminal 2 - message should appear live!

# To list daemon sessions:
codex agents --remote unix://
```

**Note**: Threads only appear in `codex agents` output after at least one message.

---

## 3. Codex Desktop App (ChatGPT) (Rank 5)

### The Problem

The ChatGPT desktop app does **NOT** use daemon mode. It spawns its own `codex app-server` processes as stdio children. There is no socket to connect to.

### The `~/.codex/ipc/ipc.sock` Socket

This socket EXISTS but is for **IDE context only** (VS Code/Cursor extension communication). It uses a different protocol and does NOT expose thread management.

### Possible Workaround (UNTESTED)

If the user manually starts a daemon:
1. `codex app-server daemon start`
2. ChatGPT desktop app might use it (unlikely - it probably spawns its own anyway)

This needs testing on a real machine.

### Fallback: AppleScript/Automation (LAST RESORT)

On macOS, could potentially use AppleScript to:
1. Activate the ChatGPT app window
2. Type text into the input field
3. Press Enter

```applescript
tell application "ChatGPT"
  activate
end tell
tell application "System Events"
  keystroke "Your message here"
  key code 36 -- Enter
end tell
```

**Cons**:
- Extremely fragile
- Platform-specific
- Requires accessibility permissions
- App must be focused
- May break with app updates

---

## 4. Claude Desktop (Rank 6)

### Status: UNKNOWN

Claude Desktop is the GUI companion to Claude Code. Investigation needed:

- Does it have an IPC socket?
- Does it support URL schemes?
- Can it be controlled via AppleScript?
- Does it integrate with Claude Code's session management?

### What We Know

- Claude Desktop creates git worktrees (mentioned in changelog)
- It has some integration with Claude Code
- May share session data

---

## Recommended Implementation Path

### Phase 1: Claude Code Terminal (Highest ROI)

Implement support for Claude Code's programmatic modes:

1. **Stream JSON mode**: For new sessions started by Wingman
2. **Background sessions**: For persistent supervised sessions
3. **Remote Control**: For users with claude.ai subscriptions

### Phase 2: Codex TUI Daemon Mode

1. Detect if daemon is running
2. Connect and inject messages
3. Document manual daemon setup for users

### Phase 3: OS Automation (Only if requested)

AppleScript/xdotool as absolute last resort for GUI apps.

---

## Technical Implementation Notes

### Claude Code Stream JSON Protocol

Input messages (stdin):

```json
{"type": "user_message", "content": "Hello"}
{"type": "tool_result", "tool_use_id": "...", "content": "..."}
```

Output messages (stdout):

```json
{"type": "assistant_message", "content": "..."}
{"type": "tool_use", "id": "...", "name": "...", "input": {...}}
{"type": "system/init", ...}
```

### Codex App-Server Protocol

Connect via WebSocket to Unix socket:

```javascript
// CRITICAL: perMessageDeflate must be false!
// The Codex app-server hangs up if the client offers compression.
const ws = new WebSocket('ws+unix:///path/to/socket:/', {
  perMessageDeflate: false,
});

// Send JSON-RPC
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "turn/start",
  params: {
    threadId: "...",
    input: [{type: "text", text: "Hello"}]
  }
}));
```

---

## Limitations and Caveats

1. **Thread Ownership**: Codex allows only one writer per thread. Injecting a message claims ownership.

2. **Session State**: Cannot inject into a session mid-turn without potentially corrupting state.

3. **Authentication**: Some paths require specific subscriptions or credentials.

4. **Platform Differences**: Solutions vary significantly by OS and client type.

5. **Version Sensitivity**: These protocols may change between versions.

6. **Thread Visibility**: Threads only appear in `thread/list` and `codex agents` output after at least one message has been sent.

7. **WebSocket Compression**: The Codex app-server hangs up if the WebSocket client offers permessage-deflate compression. Always set `perMessageDeflate: false`.

8. **TUI Connection**: In v0.152.1+, plain `codex` does NOT auto-connect to the daemon. You must use `codex --remote unix://` to connect to the app-server.

9. **Daemon Start**: `codex app-server daemon start` only works with managed installs (chatgpt.com/codex/install.sh). For Homebrew/npm installs, use `codex app-server --listen unix://` instead.

---

## 5. Claude Code Cross-Session Inbox (NEW)

### Path: Per-Session Socket Messaging - IMPLEMENTED

Claude Code sessions (interactive, background, `-p`; NOT `--bare`) bind a per-session socket that allows cross-session message injection.

**Platform Support**:
- **Unix (macOS/Linux)**: Unix domain sockets (e.g., `/tmp/cc-socks-1000/<pid>.sock`)
- **Windows**: Named pipes (e.g., `\\.\pipe\LOCAL\cc-msg-<32hex>`)

**Discovery**:
- `claude agents --json` lists live sessions with `pid`, `sessionId`, `name`, `status`/`state`, `waitingFor`
- Registry files: `~/.claude/sessions/<pid>.json` with fields:
  - `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `version`
  - `peerProtocol` (1), `peerFeatures` (e.g., `["notify_idle","artifact_yield"]`)
  - `kind` (`interactive`|`background`), `entrypoint`, `pidDomain` (e.g., `"win32:pearlwolf"`)
  - `messagingSocketPath`, `name`, `nameSource`, `nameSince`
  - `status` (`idle`|`busy`|`shell`...), `updatedAt`, `statusUpdatedAt`
- Background sessions from `claude agents --json` may have `state` instead of `status` and no `pid`
- Auth key files: `~/.claude/sessions/<pid>.<sha256hex>.key` with `{peerToken, procStartFt, pidDomain}`

**Wire Format** (newline-delimited JSON):
```json
{"type":"auth","token":"<32-char peerToken>"}
{"type":"user","message":{"role":"user","content":"Your message here"}}
```

**Authentication**:
- Auth token read from key file matching the session's pid (never logged)
- `CLAUDE_CODE_MESSAGING_TOKEN` env var overrides key file if set
- **Windows**: Auth is REQUIRED - without it the pipe closes immediately (EOF)
- **Unix**: Auth is sent when a key file exists (recommended)

**Delivery Behavior**:
- **No acknowledgement**: Server sends nothing on success; connection stays open
- **Success**: "delivered" means "written without error"
- **Rejection**: EOF or EPIPE within ~500ms after auth line = rejected (wrong token, no token on Windows)
- **Missing socket**: Connect timeout (~3s) returns `socket_missing`
- **Idle session**: Starts a new turn immediately (tested: reply in ~8s)
- **Busy session**: Message queued, delivered between tool calls ("Message from ...")
- **UTF-8**: Multi-line text, accents, CJK, and emoji (surrogate pairs) arrive intact

**Cost Note**: Each injected message is a full turn on that session's context. In testing, a single injection cost ~340k tokens (cached context). Plan accordingly for high-context sessions.

**Wingman Tools**:

```bash
# List live Claude Code sessions with inbox socket status
list_claude_live_sessions

# Send message to a running session
send_to_claude_session target="session_name_or_id" text="Your message"
```

**Live Test (verified on Windows with Claude Code 2.1.284)**:
1. Start a Claude Code session: `claude`
2. In the session, run: `echo $CLAUDE_CODE_MESSAGING_SOCKET`
3. Note the socket path (Unix: `/tmp/cc-socks-1000/<pid>.sock`, Windows: `\\.\pipe\LOCAL\cc-msg-<hex>`)
4. From Wingman, use `list_claude_live_sessions` to discover the session
5. Use `send_to_claude_session` to send a message - it appears in the interactive session!

**Pros**:
- Works with any running Claude Code session (interactive, background, -p)
- Message appears LIVE in the session
- No special session configuration required
- Supports mid-turn injection between tool calls
- UTF-8, CJK, emoji all work correctly

**Cons**:
- Registry/key file format may vary across versions (parse defensively)
- Windows requires auth token from key file
- Sessions in bypass-permissions mode may hold messages unless `crossSessionInbound=accept`
- `--bare` sessions don't bind inbox sockets
- Each injected message costs a full turn on the session's context

---

## Next Steps for Prototyping

1. **Claude Code stream-json**: Implement in Wingman as new provider mode
2. **Codex daemon injection**: Add to existing CodexProvider when daemon detected
3. **Claude Code inbox**: DONE - `list_claude_live_sessions` and `send_to_claude_session` tools
4. **Test matrix**: Document which combinations work on Mac/Linux/Windows
