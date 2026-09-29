# Live Session Message Injection Investigation

**Goal**: When a user has a Claude Code or Codex chat open, a message Grok Bot sends through Wingman should appear LIVE in that same open chat, as if the user typed it, and the reply should stream there too.

## Feasibility Rankings (Best to Worst)

| Rank | Client | Path | Feasibility | Notes |
|------|--------|------|-------------|-------|
| 1 | Claude Code Terminal | `--input-format stream-json` | **HIGH** | Programmatic stdin injection works |
| 2 | Claude Code Terminal | `--bg` + attach | **HIGH** | Background sessions can be controlled |
| 3 | Codex TUI | Shared daemon mode | **MEDIUM** | Requires manual daemon setup |
| 4 | Claude Code Terminal | `--remote-control` | **MEDIUM** | Requires claude.ai subscription |
| 5 | Codex Desktop (ChatGPT) | Manual daemon setup | **LOW** | ChatGPT app doesn't use daemon |
| 6 | Claude Desktop | Unknown IPC | **UNKNOWN** | Needs more investigation |
| 7 | Any | OS-level typing automation | **LAST RESORT** | Fragile, platform-specific |

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

### Path: Shared Daemon Mode (MEDIUM FEASIBILITY)

The Codex TUI can connect to a shared daemon instead of spawning its own embedded app-server.

**How it works**:

1. Start the Codex app-server daemon:
   ```bash
   codex app-server daemon start
   ```

2. This creates a control socket at:
   ```
   ~/.codex/app-server-control/app-server-control.sock
   ```

3. The TUI auto-detects and connects to this daemon instead of embedding

4. Wingman can also connect to this daemon via WebSocket

5. Both see the same threads; Wingman sends `turn/start` with user message

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
- User must manually start daemon
- Thread ownership is single-client (one writer at a time)
- Not yet tested with ChatGPT desktop app open simultaneously

**Setup Steps**:
1. User runs: `codex app-server daemon start`
2. User opens Codex TUI normally (it auto-connects to daemon)
3. Wingman connects to `~/.codex/app-server-control/app-server-control.sock`
4. Wingman sends `thread/list` to see threads
5. Wingman sends `turn/start` to inject message
6. Message appears in TUI, reply streams to both

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
const ws = new WebSocket('ws+unix:///path/to/socket');

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

---

## Next Steps for Prototyping

1. **Claude Code stream-json**: Implement in Wingman as new provider mode
2. **Codex daemon injection**: Add to existing CodexProvider when daemon detected
3. **Test matrix**: Document which combinations work on Mac/Linux/Windows
