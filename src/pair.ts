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
  type BridgeConfig,
} from './config.js';
import { startMcpServer } from './mcp/server.js';

function parseArgs(argv: string[]) {
  let port: number | undefined;
  let host: string | undefined;
  let reuse = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (a === '--host' && argv[i + 1]) {
      host = argv[++i];
    } else if (a === '--reuse-token') {
      reuse = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return { port, host, reuse };
}

function printHelp() {
  console.log(`Usage: wingman-pair [--port PORT] [--host HOST] [--reuse-token]
       npx wingman-mcp [--port PORT] [--host HOST] [--reuse-token]

Dual-provider MCP bridge for Codex and Claude Code.

Environment:
  CODEX_MOCK=1          Use in-memory Codex mock (no codex binary)
  CLAUDE_MOCK=1         Use in-memory Claude mock (no Claude SDK)
  WINGMAN_PORT          Server port (default 3847)
  WINGMAN_HOST          Bind host (default 127.0.0.1)
  WINGMAN_TOKEN         Override token (otherwise auto-generated)

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
  return 'no — real Codex + Claude providers';
}

function printPairInstructions(cfg: BridgeConfig, localUrl: string) {
  const tunnelHint = `https://YOUR-TUNNEL-HOST/mcp`;
  const authHeader = `Bearer ${cfg.token}`;
  const mockDisplay = getMockModeDisplay();
  const hostId = cfg.hostId ?? resolveHostId();
  const hostName = cfg.hostName ?? resolveHostName();
  const codexModel = resolveCodexModel();

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                       Wingman paired                             ║
║           Dual-provider bridge: Codex + Claude Code              ║
╚══════════════════════════════════════════════════════════════════╝

Config written: ${configPath()}
Local MCP URL:  ${localUrl}
Token:          ${cfg.token}
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
  │  → ⚠ URL changes every restart — use for demos only            │
  └────────────────────────────────────────────────────────────────┘

Then append /mcp to your tunnel URL (e.g., https://abc.trycloudflare.com/mcp).

For detailed setup help: wingman-tunnel (or: npm run tunnel)

────────────────────────────────────────────────────────────────────
MCP SERVER CONFIG (for Grok Bot / Cursor / other MCP hosts)

  name:          wingman
  url:           ${tunnelHint}
  Authorization: ${authHeader}

Example config block:
  {
    "name": "wingman",
    "url": "<YOUR_TUNNEL_URL>/mcp",
    "headers": { "Authorization": "Bearer ${cfg.token}" }
  }

────────────────────────────────────────────────────────────────────
USAGE

After pairing, the MCP host can call:
  • list_sessions(provider="codex" | "claude")
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
  const host = args.host ?? resolveHost();
  const port = args.port ?? resolvePort();
  const mock = process.env.CODEX_MOCK === '1' || process.env.CODEX_MOCK === 'true';

  // Ensure mock default for easy first-run unless user opted into real mode.
  if (mock) {
    process.env.CODEX_MOCK = '1';
  }

  let token = resolveToken();
  if (!token && args.reuse) {
    token = loadConfig()?.token;
  }
  if (!token) token = generateToken();

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
  printPairInstructions(cfg, localUrl);

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
