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

`diagnose` probes local `/healthz`, reads `~/.wingman/heartbeat.json`, reports Tailscale Funnel status, and optionally probes the public URL.

- Local health is OK and the public URL is 1033: `tunnel_down`. Restart cloudflared or Tailscale. Wingman did not crash.
- Local health fails and the public URL is 502: `server_down`. The tunnel is up and Wingman crashed.
- Local health fails and the public URL is 1033: both are down. A remote client only sees 1033, which hides the crash. The heartbeat age says when Wingman last wrote a beat (every 15 seconds while it is up).
- `heartbeatStale` is true when the file is missing or older than 5 minutes. That means the Wingman process is not writing beats. It does not by itself mean the tunnel is down. After a reboot, a stale file means nothing restarted Wingman.

Funnel status is included in the same JSON. `Funnel not enabled on tailnet` means the tailnet has not approved Funnel. The report includes the approval link Tailscale printed (`https://login.tailscale.com/...`). `wingman-tunnel tailscale` runs `tailscale funnel --bg <port>` when this port is not already published, reads `Self.DNSName` from `tailscale status --json`, and prints `https://<name>/mcp`. On Windows, pass `--bin` or set `WINGMAN_TAILSCALE_PATH` to `tailscale.exe`. `--bg` is stored by tailscaled, so the URL survives a reboot when the Tailscale service starts.

```bash
wingman-tunnel tailscale
wingman-tunnel tailscale --bin "C:\Program Files\Tailscale\tailscale.exe"
wingman-tunnel diagnose --url https://YOUR-TUNNEL-HOST
```

`/status` returns the same JSON as `/healthz`. Both follow `WINGMAN_HEALTHZ_AUTH_FREE`.

## Windows scheduled task

`wingman-task install` writes `%USERPROFILE%\.wingman\wingman-task.xml` and, on Windows, registers it:

```bash
wingman-task install
wingman-task install --tunnel tailscale --tailscale-bin "C:\Program Files\Tailscale\tailscale.exe"
wingman-task install --tunnel quick
wingman-task status
wingman-task uninstall
wingman-task print-xml
```

The task:

- Runs at user logon and at boot, as the user who installed it (least privilege).
- Restarts one minute after a crash, up to 999 times.
- Has no execution time limit, so a long bridge is not killed by Task Scheduler.
- Starts `node` with `pair.js` and does **not** pass `--new-token`.
- With `--tunnel tailscale`, also passes `--ensure-tunnel tailscale`. Funnel `--bg` persists in tailscaled, so the task checks that the funnel is active and republishes the port only when it is not.
- With `--tunnel quick`, starts a Cloudflare quick tunnel. The trycloudflare.com hostname changes every start. Use it for a demo, not for a connector you want to keep.

The bearer token is created once, in `%USERPROFILE%\.wingman\config.json`, and reused on every start. A crash restart does not rotate it. Rotate on purpose with `wingman-pair --rotate-token` or `wingman-token rotate`, then restart the task so it reads the new file. Output is masked unless you pass `--show-token`. `WINGMAN_TOKEN` overrides the file.

The default listen address is `127.0.0.1`. DNS rebinding protection is on, and the allowlist includes the Funnel or tunnel hostname (`WINGMAN_TUNNEL_HOST`, `WINGMAN_ALLOWED_HOSTS`, or `tunnelHost` in the config file). Opt into every interface with `--host 0.0.0.0` or `WINGMAN_HOST=0.0.0.0`. Protection stays on. Add the Host header clients will send, or those requests are rejected.

`get_bridge_status` includes `heartbeatAgeMs`, `heartbeatStale`, and `heartbeatWarning`. The file is rewritten about every 15 seconds. Older than 5 minutes means this process is not writing beats.

`list_sessions` and `get_status` include `pendingApprovalAgeMs` and `stalled_on_approval`. The flag is true when the oldest pending approval is at least 10 minutes old. `WINGMAN_APPROVAL_STALL_MS` changes the threshold.

Commands that spawn `claude`, `tailscale`, or `cloudflared` use `shell: false`. On Windows the `.cmd` or `.exe` path is resolved first. That avoids Node's DEP0190 warning, which is raised when arguments are passed with `shell: true`.

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
