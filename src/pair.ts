#!/usr/bin/env node
/**
 * Easy pair CLI:
 * 1. Generate bearer token
 * 2. Write ~/.wingman/config.json
 * 3. Start MCP on 127.0.0.1:PORT
 * 4. Print tunnel + AddMcpServer instructions for Grok Bot
 */

import {
  generateToken,
  saveConfig,
  resolveHost,
  resolvePort,
  resolveToken,
  loadConfig,
  mcpUrl,
  configPath,
  resolveHostId,
  resolveHostName,
  resolveCodexModel,
  maskToken,
  rotateStoredToken,
  formatRotationMessage,
  weakTokenReason,
  safeErrorText,
  type BridgeConfig,
} from './config.js';
import { startMcpServer } from './mcp/server.js';
import { ensureConfiguredTunnel } from './ensure-tunnel.js';

function parseArgs(argv: string[]) {
  let port: number | undefined;
  let host: string | undefined;
  let reuse = false;
  let newToken = false;
  let showToken = false;
  let rotate = false;
  let ensureTunnel: 'none' | 'tailscale' | 'quick' = 'none';
  let tailscaleBin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (a === '--host' && argv[i + 1]) {
      host = argv[++i];
    } else if (a === '--reuse-token') {
      reuse = true;
    } else if (a === '--new-token') {
      newToken = true;
    } else if (a === '--rotate-token') {
      rotate = true;
    } else if (a === '--show-token') {
      showToken = true;
    } else if (a === '--ensure-tunnel' && argv[i + 1]) {
      const mode = argv[++i];
      if (mode === 'tailscale' || mode === 'quick' || mode === 'none') ensureTunnel = mode;
      else throw new Error('--ensure-tunnel expects tailscale, quick, or none');
    } else if (a === '--tailscale-bin' && argv[i + 1]) {
      tailscaleBin = argv[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return { port, host, reuse, newToken, showToken, rotate, ensureTunnel, tailscaleBin };
}

function printHelp() {
  console.log(`Usage: wingman-pair [--port PORT] [--host HOST] [--new-token] [--rotate-token] [--show-token]
       wingman-pair --ensure-tunnel tailscale|quick [--tailscale-bin PATH]
       npx wingman-mcp [--port PORT] [--host HOST] [--new-token] [--show-token]

Dual-provider MCP bridge for Codex and Claude Code.

Options:
  --port PORT           Server port (default 3847, or WINGMAN_PORT env)
  --host HOST           Bind host (default 127.0.0.1, or WINGMAN_HOST env)
                        Pass 0.0.0.0 only when you mean to listen on every interface.
                        DNS rebinding protection stays on. Set WINGMAN_ALLOWED_HOSTS
                        or WINGMAN_TUNNEL_HOST to the Funnel or tunnel hostname.
  --new-token           Generate a fresh token and start the server (default: reuse existing)
  --rotate-token        Write a new token and exit. A running server picks it up on restart.
  --reuse-token         Explicitly reuse existing token (now the default)
  --show-token          Show full token in output (default: masked)
  --ensure-tunnel MODE  tailscale, quick, or none. tailscale checks Funnel and runs
                        tailscale funnel --bg when the port is not already published.
  --tailscale-bin PATH  Path to tailscale.exe on Windows, or the tailscale binary.

Environment:
  CODEX_MOCK=1          Use in-memory Codex mock (no codex binary)
  CLAUDE_MOCK=1         Use in-memory Claude mock (no Claude SDK)
  WINGMAN_PORT          Server port (default 3847)
  WINGMAN_HOST          Bind host (default 127.0.0.1)
  WINGMAN_TOKEN         Override token (otherwise reused from config or generated)
  WINGMAN_HOST_ID       Machine identifier for multi-host setups
  WINGMAN_HOST_NAME     Human-friendly host name for display
  WINGMAN_CODEX_MODEL   Override Codex model for Wingman sessions (optional)
  WINGMAN_CLAUDE_MODEL  Optional Claude model override (unset inherits the session model)
  WINGMAN_CLAUDE_MAX_TURNS  Claude agent turns per query (default 50)
  WINGMAN_ALLOWED_PATHS Allowlisted project roots, split on the OS path delimiter
  WINGMAN_CALLER        Caller id for the allowlist (default "default")

Windows service: wingman-task install
  Registers a scheduled task that starts at logon and boot, restarts after a crash,
  and does not pass --new-token, so the bearer token stays stable.

Real mode:
  Codex:  requires \`codex\` on PATH (uses \`codex app-server\` JSON-RPC)
  Claude: uses bundled @anthropic-ai/claude-agent-sdk

Run \`wingman-doctor\` to check your environment.
`);
}

function getMockModeDisplay(): string {
  const codexMock = process.env.CODEX_MOCK === '1' || process.env.CODEX_MOCK === 'true';
  const claudeMock = process.env.CLAUDE_MOCK === '1' || process.env.CLAUDE_MOCK === 'true';

  if (codexMock && claudeMock) {
    return 'YES (both CODEX_MOCK=1 and CLAUDE_MOCK=1)';
  } else if (codexMock) {
    return 'Codex mock (CODEX_MOCK=1), Claude real';
  } else if (claudeMock) {
    return 'Codex real, Claude mock (CLAUDE_MOCK=1)';
  }
  return 'no (real Codex and Claude providers)';
}

export function printPairInstructions(cfg: BridgeConfig, localUrl: string, showToken: boolean) {
  const tunnelHint = `https://YOUR-TUNNEL-HOST/mcp`;
  const displayToken = showToken ? cfg.token : maskToken(cfg.token);
  const authHeader = `Bearer ${displayToken}`;
  const mockDisplay = getMockModeDisplay();
  const hostId = cfg.hostId ?? resolveHostId();
  const hostName = cfg.hostName ?? resolveHostName();
  const codexModel = resolveCodexModel();
  const cfgPath = configPath();

  const tokenNote = showToken
    ? ''
    : `  (masked; full token in ${cfgPath}, or use --show-token)`;

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                       Wingman paired                             ║
║           Dual-provider bridge: Codex + Claude Code              ║
╚══════════════════════════════════════════════════════════════════╝

Config written: ${cfgPath}
Local MCP URL:  ${localUrl}
Token:          ${displayToken}${tokenNote}
Mock mode:      ${mockDisplay}
Host ID:        ${hostId}
Host Name:      ${hostName}${codexModel ? `\nCodex Model:    ${codexModel} (override active)` : ''}

────────────────────────────────────────────────────────────────────
TUNNEL SETUP (required for remote access)

Remote hosts (Grok Bot, Cursor Cloud, etc.) cannot reach 127.0.0.1.
Pick one tunnel option, ranked by durability:

  ┌─ 1. Tailscale Serve (stable, loopback to your network) ────────┐
  │  tailscale serve --bg ${cfg.port}                                      │
  │  → Your Tailscale network can reach https://<machine>.ts.net   │
  │  → URL stays the same across restarts                          │
  └────────────────────────────────────────────────────────────────┘

  ┌─ 2. Tailscale Funnel (stable, public) ─────────────────────────┐
  │  tailscale funnel ${cfg.port}                                          │
  │  → Public URL: https://<machine>.ts.net (requires Funnel ACL)  │
  │  → URL stays the same across restarts                          │
  └────────────────────────────────────────────────────────────────┘

  ┌─ 3. Cloudflare Named Tunnel (stable, custom domain) ───────────┐
  │  cloudflared tunnel run <TUNNEL_NAME>                          │
  │  → Stable hostname like https://wingman.yourdomain.com         │
  │  → One-time setup: run 'wingman-tunnel' for instructions       │
  └────────────────────────────────────────────────────────────────┘

  ┌─ 4. Cloudflare Quick Tunnel (ephemeral, for demos) ────────────┐
  │  cloudflared tunnel --url http://${cfg.host}:${cfg.port}                       │
  │  → Gives you a URL like https://abc.trycloudflare.com          │
  │  → ⚠ URL changes every restart. Use for demos only.          │
  └────────────────────────────────────────────────────────────────┘

Then append /mcp to your tunnel URL (e.g., https://abc.trycloudflare.com/mcp).

For detailed setup help: wingman-tunnel (or: npm run tunnel)

────────────────────────────────────────────────────────────────────
MCP SERVER CONFIG (for Grok Bot / Cursor / other MCP hosts)

  name:          wingman
  url:           ${tunnelHint}
  Authorization: ${authHeader}

Example config block (use full token from ${cfgPath}):
  {
    "name": "wingman",
    "url": "<YOUR_TUNNEL_URL>/mcp",
    "headers": { "Authorization": "Bearer <TOKEN>" }
  }

────────────────────────────────────────────────────────────────────
USAGE

After pairing, the MCP host can call:
  • list_sessions(provider="codex" | "claude", state="live" | "past" | "all")
  • list_claude_live_sessions / send_to_claude_session
  • create_session(provider, cwd?, prompt?)
  • read_transcript / send_message / interrupt

Both Codex and Claude sessions are supported via the same bridge.

────────────────────────────────────────────────────────────────────
TROUBLESHOOTING

  Environment check:    wingman-doctor   (or: npm run doctor)
  Tunnel help:          wingman-tunnel   (or: npm run tunnel)

Ctrl+C to stop the bridge.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rotate) {
    const rotated = rotateStoredToken();
    console.log(
      formatRotationMessage({
        path: rotated.path,
        token: rotated.token,
        showToken: args.showToken,
        previousWasWeak: rotated.previousWasWeak,
        weakReason: rotated.weakReason,
      }),
    );
    return;
  }
  const host = args.host ?? resolveHost();
  const port = args.port ?? resolvePort();
  const mock = process.env.CODEX_MOCK === '1' || process.env.CODEX_MOCK === 'true';

  // Ensure mock default for easy first-run unless user opted into real mode.
  if (mock) {
    process.env.CODEX_MOCK = '1';
  }

  // Token precedence: WINGMAN_TOKEN env > existing config (default reuse) > generate new
  // Default: reuse existing token to avoid printing new tokens in logs (security concern)
  // Use --new-token to explicitly generate a fresh token
  let token = resolveToken();
  const existingConfig = loadConfig();
  if (!token && existingConfig?.token && !args.newToken) {
    // Default: reuse existing token when config exists
    token = existingConfig.token;
    console.error('[wingman] Reusing existing token from config (use --new-token to regenerate)');
  }
  if (!token) token = generateToken();
  const weak = weakTokenReason(token);
  if (weak) {
    console.error(
      `[wingman] The configured token ${weak}. Run wingman-pair --rotate-token before exposing the bridge.`,
    );
  }

  const hostId = resolveHostId();
  const hostName = resolveHostName();

  const cfg: BridgeConfig = {
    token,
    host,
    port,
    mcpPath: '/mcp',
    createdAt: new Date().toISOString(),
    mock,
    hostId,
    hostName,
  };
  saveConfig(cfg);

  const localUrl = mcpUrl(host, port, '/mcp');
  printPairInstructions(cfg, localUrl, args.showToken);

  if (args.ensureTunnel !== 'none') {
    const ensured = ensureConfiguredTunnel({
      mode: args.ensureTunnel,
      port,
      host,
      tailscaleBin: args.tailscaleBin,
    });
    console.error(`[wingman] tunnel: ${ensured.summary}`);
    if (ensured.connectorUrl) console.error(`[wingman] connector: ${ensured.connectorUrl}`);
  }

  const server = await startMcpServer({
    host,
    port,
    token,
    quiet: true,
  });

  console.error(`[wingman] listening on ${server.url}`);

  const shutdown = async () => {
    console.error('\n[wingman] shutting down…');
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const isMain = /(?:^|[\\/])pair\.(ts|js)$/.test(process.argv[1] ?? '');

if (isMain) {
  main().catch((err) => {
    console.error(safeErrorText(err, [loadConfig()?.token, process.env.WINGMAN_TOKEN]));
    process.exit(1);
  });
}
