# Operations

How a supervisor tells a dead tunnel from a dead process, how Wingman stays up on Windows, and how headless runs, status, and path allowlists work.

## When the MCP call fails

`get_bridge_status` and `GET /healthz` only answer while this process is alive. They return `state: "server_up"` plus pid and uptime. They also list the rules below, so a client that connected earlier still has them.

After the process is gone, classify the HTTP failure:

| What you see | State | What it means |
|---|---|---|
| HTTP 200 | `server_up` | Wingman answered. |
| HTTP 401 or 403 | `auth_rejected` | Wingman is up. The bearer token is missing or wrong. |
| Cloudflare error 1033, or HTTP 530 | `tunnel_down` | cloudflared is not connected to Cloudflare. The machine may be asleep, or only the tunnel process stopped. This does not prove Wingman crashed. |
| HTTP 502 or 504 | `server_down` | The tunnel is up and the origin refused the connection. Wingman is not listening. |
| `fetch failed`, `ENOTFOUND`, `ETIMEDOUT`, or a timeout with no HTTP status | `host_offline` | The client never reached the hostname. |
| `ECONNREFUSED` to the host and port | `server_down` | A machine answered and nothing is listening. That is not `host_offline`. |

On the machine itself, the host is on by definition. Run:

```bash
wingman-tunnel diagnose --url https://YOUR-TUNNEL-HOST
wingman-tunnel classify --status 530 --body "error code: 1033"
```

`diagnose` probes local `/healthz`, reads `~/.wingman/heartbeat.json`, and optionally probes the public URL.

- Local health is OK and the public URL is 1033: `tunnel_down`. Restart cloudflared or Tailscale. Wingman did not crash.
- Local health fails and the public URL is 502: `server_down`. The tunnel is up and Wingman crashed.
- Local health fails and the public URL is 1033: both are down. A remote client only sees 1033, which hides the crash. The heartbeat age says when Wingman last wrote a beat (every 15 seconds while it is up).

`/status` returns the same JSON as `/healthz`. Both follow `WINGMAN_HEALTHZ_AUTH_FREE`.

## Windows scheduled task

`wingman-task install` writes `%USERPROFILE%\.wingman\wingman-task.xml` and, on Windows, registers it:

```bash
wingman-task install
wingman-task status
wingman-task uninstall
wingman-task print-xml
```

The task:

- Runs at user logon and at boot, as the user who installed it (least privilege).
- Restarts one minute after a crash, up to 999 times.
- Has no execution time limit, so a long bridge is not killed by Task Scheduler.
- Starts `node` with `pair.js` and does **not** pass `--new-token`.

The bearer token is created once, in `%USERPROFILE%\.wingman\config.json`, and reused on every start. A crash restart does not rotate it.

On Linux or macOS the command writes the XML and prints the `schtasks` line. It does not register a task there.

A boot trigger still runs as that user. The token file is in the user profile, so install the task from the account that owns the Codex and Claude logins.

## Headless Codex exec

`start_codex_exec` spawns `codex exec` with the flags from CLI 0.166:

```text
codex exec --cd <cwd> --sandbox <read-only|workspace-write|danger-full-access> --model <model> --json --color never -
codex exec resume --cd <cwd> --sandbox <sandbox> --model <model> --json --color never <session-id> -
```

`--full-auto` is not passed. It was removed. The default sandbox is `read-only`. Use `workspace-write` when the run should edit files.

The prompt is written to the child stdin (`-`). The process is spawned with `shell: false`. The prompt is not placed in a PowerShell command, so multi-line text survives Windows PowerShell 5.

`get_run` returns status, exit code, the output tail, the thread id from `thread.started` when Codex prints one, and RSS when `/proc` can be read.

`stop` with `run_id` sends SIGTERM. `force: true` sends SIGKILL. That pid belongs only to this exec, so killing it does not take down other sessions.

## Headless Claude runs

`run_headless` starts a long Claude turn through the Agent SDK. The prompt is a JavaScript string. It never goes through PowerShell.

Pass `max_turns` and `permission_mode` the same way as `send_message`. Omit `model` to inherit the session model. Pass `session_id` to continue a session, or `cwd` to start one.

Poll with `get_run`. Status is `running`, `awaiting_approval`, `completed`, `failed`, or `killed`.

Claude turns run inside the Wingman process. `memory.bytes` is that shared RSS, not a private allocation. `stop` interrupts the turn. It does not kill the Wingman process.

## Session status

`get_status` returns:

| Field | Meaning |
|---|---|
| `state` | `idle`, `working`, `awaiting_approval`, or `errored` |
| `lastActivityAt` | Last session update time |
| `pendingPrompt` | Prompt text while the state is `working` or `awaiting_approval` |
| `model` | Model Wingman last observed or requested |
| `git.head` | `git rev-parse HEAD` in the session cwd |
| `git.dirtyFiles` | `git status --porcelain` paths |
| `memory` | RSS for the owning process, with `shared: true` when the process serves more than one session |

Codex interactive sessions share one `codex app-server` process. Stopping one session interrupts that turn. It does not SIGKILL the shared server. Headless `codex exec` runs are the ones with their own pid.

On Windows, RSS for a pid other than Wingman itself is omitted, because there is no `/proc`. The note on `memory` says so.

## Caller allowlist

Set roots so each supervisor only sees its repos. Paths use the OS path delimiter (`:` on macOS and Linux, `;` on Windows) so a drive letter is not split:

```bash
WINGMAN_CALLER=grok
WINGMAN_ALLOWED_PATHS='D:\work\app;D:\work\other'
```

Or `~/.wingman/allowlist.json`:

```json
{
  "callers": {
    "default": ["D:\\work\\app"],
    "grok": ["D:\\work\\app", "D:\\work\\other"]
  }
}
```

A tool may pass `caller`. If it does not, Wingman uses `WINGMAN_CALLER` or `default`.

When a policy is in force:

- `list_sessions` drops sessions whose cwd is outside the roots. Provider stubs (`not_enabled`) stay, because they are not repos.
- `create_session`, `start_codex_exec`, and `run_headless` reject a cwd outside the roots.
- Other session tools reject a session whose cwd is outside the roots.
- A caller id that is missing from a non-empty allowlist file, with no env roots, sees nothing.

The match is a directory prefix, so `D:\work\app` does not allow `D:\work\app-evil`. Windows paths are compared case-insensitively. `..` is removed lexically.

This is a scope check on a shared bearer token. It is not a second secret. Anyone who can call the server can pass a caller id that the file defines.
