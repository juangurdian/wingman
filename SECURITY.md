# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Wingman, please report it privately:

1. **Do not** open a public GitHub issue
2. Email the maintainer or use GitHub's private vulnerability reporting (Security tab → Report a vulnerability)
3. Include steps to reproduce, impact assessment, and any suggested fixes

We aim to acknowledge reports within 48 hours and provide a fix timeline within 7 days.

## Security Model

### Bearer Token Authentication

Wingman protects its MCP endpoint with a bearer token:

- **Auto-generated**: `wingman-pair` generates a cryptographically random 32-byte token (base64url encoded)
- **Storage**: Token is saved to `~/.wingman/config.json` with mode `0600` (owner read/write only)
- **Transmission**: Token must be sent in the `Authorization: Bearer <token>` header

**Best practices:**
- Never commit tokens to version control
- Rotate tokens periodically by deleting `~/.wingman/config.json` and re-running `wingman-pair`
- Use HTTPS tunnels (Cloudflare, Tailscale) — never expose HTTP directly to the internet

### Loopback Binding

By default, Wingman binds to `127.0.0.1`:

- The MCP server is **not** accessible from the network without a tunnel
- This prevents accidental exposure of your local agent sessions
- Override with `WINGMAN_HOST` only if you understand the implications

### Token Rotation

To rotate your bearer token:

```bash
rm ~/.wingman/config.json
wingman-pair
```

This generates a new token. Update your MCP host configuration with the new token.

**Rotation best practices:**
- Rotate tokens after sharing them in demos or screenshots (even if redacted)
- Rotate if you suspect the token was exposed (logs, error messages, etc.)
- Consider rotating monthly for long-running deployments
- After rotation, update all MCP host configurations that use this token

### Tunnel State

Wingman persists tunnel-related state in `~/.wingman/tunnel-state.json`:

```json
{
  "lastPublicUrl": "https://abc.trycloudflare.com/mcp",
  "lastTunnelType": "quick-tunnel",
  "tokenHintPath": "~/.wingman/config.json",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

**What's stored:**
- `lastPublicUrl`: The last known public tunnel URL (for reference only)
- `lastTunnelType`: The type of tunnel used (tailscale-serve, named-cloudflare, quick-tunnel)
- `tokenHintPath`: Path to the config file containing the token
- `updatedAt`: When the state was last updated

**No secrets stored**: The tunnel state file does not contain tokens or credentials. The bearer token is only stored in `~/.wingman/config.json` (with mode `0600`).

To record a new tunnel URL for future reference:

```bash
wingman-tunnel --record-url https://your-tunnel-url.com/mcp
```

To view saved tunnel state:

```bash
wingman-tunnel --show-state
```

### Tunnel Security

When exposing Wingman via a tunnel:

- **Cloudflare Tunnel**: Traffic is encrypted end-to-end; URL is ephemeral unless you configure a persistent tunnel
- **Tailscale Funnel**: Traffic is encrypted; access is limited to your Tailscale network or explicitly shared URLs

Always verify the tunnel URL before sharing it. Anyone with the URL and token can interact with your local agent sessions.

## What Wingman Does NOT Do

- **No TTY hijacking**: Wingman does not attach to terminal processes or inject keystrokes
- **No auto-approval**: Sandbox prompts and confirmations remain with the local agent client
- **No secrets storage**: Wingman only stores its bearer token; bring your own API keys for Codex/Claude
- **No persistent daemon**: Wingman runs when you pair; no always-on background service

## Dependencies

Wingman depends on:
- `@anthropic-ai/claude-agent-sdk` — Official Claude Code SDK
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `express` — HTTP server
- `zod` — Input validation

Keep dependencies updated to receive security patches:

```bash
npm update
npm audit fix
```
