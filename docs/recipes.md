# Recipes

Concrete setups for the three main ways people use Wingman. Each one starts in mock mode so you can see the flow before pointing it at real agents.

If a recipe doesn't work for your setup, [open an issue](https://github.com/juangurdian/wingman/issues/new/choose) with what you tried — fixing the docs for the next person counts as a contribution.

---

## 1. Check in on your agents from anywhere

**You want:** to start long work in Claude Code or Codex at your desk, then check progress and approve commands from another assistant (on your phone, in a browser, in Grok).

**Setup**

```bash
# 1. Start Wingman (drop the *_MOCK vars for real agents)
CODEX_MOCK=1 CLAUDE_MOCK=1 npx wingman-mcp

# 2. Expose it privately to your own devices
tailscale serve --bg 3847
```

Tailscale Serve keeps the endpoint inside your tailnet. Only use a public tunnel (Tailscale Funnel, Cloudflare) if your host can't join the tailnet — anyone with the URL and token can approve commands on your machine. Run `wingman-tunnel` for all options.

**3. Add Wingman to your remote host** with URL `https://<your-tailnet-host>/mcp` and header `Authorization: Bearer <token>`. Host-specific steps: [docs/hosts/](hosts/README.md).

**Things to ask your host**

- "List my coding sessions and tell me which ones are running."
- "Start a Claude session in `~/code/api` and ask it to add pagination to `/users`. Wait for it and tell me what it needs."
- "What is the Claude session waiting on? Show me the exact command before I approve it."
- "Approve it once" → `resolve_approval` with `accept`; "Don't run that, tell it to use the migration script instead" → `decline`, then `send_message`.

**Try the approval flow in mock mode:** create a Claude session with the prompt `sudo apt update`. The turn pauses; `list_approvals` shows the command and `resolve_approval` lets it finish.

---

## 2. Second opinion across agents

**You want:** one agent to review the other's work — Claude Code reviewing a Codex change, or Codex double-checking Claude.

Both agents and Wingman run on the same machine, so no tunnel is needed.

```bash
# Terminal 1: Wingman (real Codex, Claude via the SDK)
npx wingman-mcp

# Terminal 2: give Claude Code access to Wingman
claude mcp add --transport http wingman http://127.0.0.1:3847/mcp \
  --header "Authorization: Bearer <token printed by wingman>"
```

**Things to ask Claude Code**

- "Use wingman to find my most recent Codex session, read its transcript, and review the changes it made in this repo. List anything risky."
- "Send the Codex session your review as a message and wait for it to respond."

Any MCP client that can reach `127.0.0.1` with a bearer header works the same way — see [docs/hosts/](hosts/README.md).

---

## 3. Agents on a dev box

**You want:** Codex or Claude Code running on a home server or cloud VM, driven from your laptop or phone.

```bash
# On the dev box, inside tmux or screen so it survives SSH disconnects
npx wingman-mcp
tailscale serve --bg 3847
```

Wingman does not install itself as a service (see [non-goals](../ROADMAP.md#non-goals)); tmux, screen, or your own process manager keeps it running.

Useful tools for this setup:

- `create_session` with `cwd` to start work in a specific checkout, and `name` / `tags` to find it later.
- `wait_turn` with a long `timeout_ms` (up to 300000) instead of polling.
- `export_transcript` to save a session as Markdown when the work is done.
- `CLAUDE_PERMISSION_MODE=acceptEdits` if you trust file edits on that box and only want to approve commands.

Running Wingman on several machines? See [docs/hosts/multi-host.md](hosts/multi-host.md).
