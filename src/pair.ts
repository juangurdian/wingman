#!/usr/bin/env node
/**
 * Easy pair CLI:
 * 1. Generate bearer token
 * 2. Write ~/.session-bridge/config.json
 * 3. Start MCP on 127.0.0.1:PORT
 * 4. Print tunnel + AddMcpServer instructions for Grok Bot
 */

import {
  generateToken,
  saveConfig,
  resolveHost,
  resolvePort,
  mcpUrl,
  configPath,
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
  console.log(`Usage: npm run pair -- [--port PORT] [--host HOST] [--reuse-token]

Environment:
  CODEX_MOCK=1          Use in-memory Codex mock (no codex binary)
  SESSION_BRIDGE_PORT   Default port (default 3847)
  SESSION_BRIDGE_HOST   Bind host (default 127.0.0.1)
  SESSION_BRIDGE_TOKEN  Override token (otherwise generated)

Real Codex mode requires \`codex\` on PATH and uses \`codex app-server\` (stdio JSON-RPC).
Do not use removed \`codex mcp-server\`.
`);
}

function printPairInstructions(cfg: BridgeConfig, localUrl: string) {
  const tunnelHint = `https://YOUR-TUNNEL-HOST/mcp`;
  const authHeader = `Bearer ${cfg.token}`;

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    session-bridge paired                         ║
╚══════════════════════════════════════════════════════════════════╝

Config written: ${configPath()}
Local MCP URL:  ${localUrl}
Token:          ${cfg.token}
Mock mode:      ${cfg.mock ? 'YES (CODEX_MOCK=1)' : 'no — requires codex on PATH'}

────────────────────────────────────────────────────────────────────
Grok Bot cannot reach 127.0.0.1 on your machine. Expose a tunnel:

  # Cloudflare quick tunnel (ephemeral URL)
  cloudflared tunnel --url http://${cfg.host}:${cfg.port}

  # Tailscale Funnel (stable, if you use Tailscale)
  tailscale funnel ${cfg.port}

Use the HTTPS URL from the tunnel, with path /mcp
(example: https://abc.trycloudflare.com/mcp).

────────────────────────────────────────────────────────────────────
Add MCP server fields for Grok Bot / Cursor AddMcpServer:

  name:          session-bridge
  url:           ${tunnelHint}
  Authorization: ${authHeader}

Exact values once you have a public URL:

  name: session-bridge
  url:  <PUBLIC_HTTPS_URL>/mcp
  headers:
    Authorization: Bearer ${cfg.token}

────────────────────────────────────────────────────────────────────
After pairing, ask Grok Bot to:
  1. list_sessions (provider=codex)
  2. read_transcript / send_message / interrupt

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

  let token = process.env.SESSION_BRIDGE_TOKEN?.trim();
  if (!token && args.reuse) {
    const { loadConfig } = await import('./config.js');
    token = loadConfig()?.token;
  }
  if (!token) token = generateToken();

  const cfg: BridgeConfig = {
    token,
    host,
    port,
    mcpPath: '/mcp',
    createdAt: new Date().toISOString(),
    mock,
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

  console.error(`[session-bridge] listening on ${server.url}`);

  const shutdown = async () => {
    console.error('\n[session-bridge] shutting down…');
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
