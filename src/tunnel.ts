#!/usr/bin/env node
/**
 * Tunnel helpers for Wingman
 *
 * Detects available tunnel tools, generates ready-to-copy commands,
 * and persists tunnel state for better DX.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { hostnameFromUrl } from './bind.js';
import { configDir, loadConfig, resolvePort, resolveHost, safeErrorText, saveConfig } from './config.js';
import {
  classifyRemoteFailure,
  describeHeartbeat,
  diagnoseLocal,
  heartbeatAgeMs,
  readHeartbeat,
} from './reachability.js';
import {
  executeFunnel,
  funnelConnectorUrl,
  readFunnelDiagnosis,
  resolveTailscaleBin,
  spawnCommandRunner,
  type FunnelDiagnosis,
} from './tailscale.js';

export interface TunnelTool {
  name: string;
  binary: string;
  installed: boolean;
  version?: string;
  recommendation: TunnelRecommendation;
}

export type TunnelRecommendation = 'tailscale-serve' | 'tailscale-funnel' | 'named-cloudflare' | 'quick-tunnel';

export interface TunnelState {
  lastPublicUrl?: string;
  lastTunnelType?: TunnelRecommendation | 'unknown';
  tokenHintPath: string;
  updatedAt: string;
}

export interface TunnelCommand {
  tool: string;
  command: string;
  description: string;
  durability: 'stable' | 'semi-stable' | 'ephemeral';
  setupRequired?: string;
  windowsNote?: string;
}

const TUNNEL_STATE_FILE = 'tunnel-state.json';

export function tunnelStatePath(): string {
  return join(configDir(), TUNNEL_STATE_FILE);
}

export function loadTunnelState(): TunnelState | null {
  const path = tunnelStatePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TunnelState;
  } catch {
    return null;
  }
}

export function saveTunnelState(state: Partial<TunnelState>): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existing = loadTunnelState() || {
    tokenHintPath: join(configDir(), 'config.json'),
  };

  const merged: TunnelState = {
    ...existing,
    ...state,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(tunnelStatePath(), `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function detectBinary(binary: string): { found: boolean; version?: string } {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error) {
      return { found: false };
    }

    const version = (result.stdout || result.stderr || '').trim().split('\n')[0];
    return { found: result.status === 0, version: version || undefined };
  } catch {
    return { found: false };
  }
}

export function detectCloudflared(): TunnelTool {
  const result = detectBinary('cloudflared');
  return {
    name: 'Cloudflare Tunnel (cloudflared)',
    binary: 'cloudflared',
    installed: result.found,
    version: result.version,
    recommendation: 'quick-tunnel',
  };
}

export function detectTailscale(): TunnelTool {
  const result = detectBinary('tailscale');
  return {
    name: 'Tailscale',
    binary: 'tailscale',
    installed: result.found,
    version: result.version,
    recommendation: 'tailscale-serve',
  };
}

export function detectAllTunnelTools(): TunnelTool[] {
  return [detectTailscale(), detectCloudflared()];
}

export function isWindows(): boolean {
  return platform() === 'win32';
}

export function generateTunnelCommands(port: number, host: string): TunnelCommand[] {
  const commands: TunnelCommand[] = [];
  const isWin = isWindows();

  commands.push({
    tool: 'Tailscale Serve (loopback, stable)',
    command: `tailscale serve --bg ${port}`,
    description:
      'Exposes the port to your Tailscale network. Stable URL based on your machine name.',
    durability: 'stable',
    setupRequired: 'Tailscale installed and authenticated (https://tailscale.com/download)',
    windowsNote: isWin
      ? 'On Windows, run from an elevated PowerShell or use the Tailscale tray app.'
      : undefined,
  });

  commands.push({
    tool: 'Tailscale Funnel (public, stable)',
    command: `tailscale funnel ${port}`,
    description:
      'Exposes the port publicly via Tailscale Funnel. URL: https://<machine>.ts.net. Requires Funnel enabled in ACL.',
    durability: 'stable',
    setupRequired:
      'Tailscale installed + Funnel enabled (https://tailscale.com/kb/1223/funnel)',
    windowsNote: isWin
      ? 'On Windows, run from an elevated PowerShell or use the Tailscale tray app.'
      : undefined,
  });

  commands.push({
    tool: 'Cloudflare Named Tunnel (stable)',
    command: `cloudflared tunnel run <TUNNEL_NAME>`,
    description:
      'Uses a pre-configured named tunnel with a stable hostname. Requires one-time setup.',
    durability: 'stable',
    setupRequired: `
  # One-time setup:
  cloudflared tunnel login
  cloudflared tunnel create wingman
  cloudflared tunnel route dns wingman wingman.<YOUR_DOMAIN>
  # Create ~/.cloudflared/config.yml with:
  #   tunnel: <TUNNEL_ID>
  #   credentials-file: ~/.cloudflared/<TUNNEL_ID>.json
  #   ingress:
  #     - hostname: wingman.<YOUR_DOMAIN>
  #       service: http://localhost:${port}
  #     - service: http_status:404`,
    windowsNote: isWin
      ? 'Config file location on Windows: %USERPROFILE%\\.cloudflared\\config.yml'
      : undefined,
  });

  commands.push({
    tool: 'Cloudflare Quick Tunnel (ephemeral)',
    command: `cloudflared tunnel --url http://${host}:${port}`,
    description:
      'Creates an ephemeral tunnel with a random trycloudflare.com hostname. URL changes every restart.',
    durability: 'ephemeral',
    windowsNote: isWin ? 'Works the same on Windows from PowerShell or CMD.' : undefined,
  });

  return commands;
}

export function getRankedRecommendations(
  tools: TunnelTool[],
  port: number,
  host: string,
): TunnelCommand[] {
  const tailscale = tools.find((t) => t.binary === 'tailscale');
  const cloudflared = tools.find((t) => t.binary === 'cloudflared');
  const commands = generateTunnelCommands(port, host);

  const ranked: TunnelCommand[] = [];

  if (tailscale?.installed) {
    ranked.push(commands.find((c) => c.tool.includes('Tailscale Serve'))!);
    ranked.push(commands.find((c) => c.tool.includes('Tailscale Funnel'))!);
  }

  if (cloudflared?.installed) {
    ranked.push(commands.find((c) => c.tool.includes('Cloudflare Named'))!);
    ranked.push(commands.find((c) => c.tool.includes('Quick Tunnel'))!);
  }

  if (ranked.length === 0) {
    return commands;
  }

  return ranked;
}

function formatDurability(durability: TunnelCommand['durability']): string {
  const icons = {
    stable: '🟢 stable',
    'semi-stable': '🟡 semi-stable',
    ephemeral: '🟠 ephemeral',
  };
  return icons[durability];
}

export function printTunnelHelp(): void {
  const config = loadConfig();
  const port = config?.port ?? resolvePort();
  const host = config?.host ?? resolveHost();
  const tools = detectAllTunnelTools();
  const state = loadTunnelState();
  const commands = getRankedRecommendations(tools, port, host);

  const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
  };

  console.log(`
${colors.bold}╔══════════════════════════════════════════════════════════════════╗
║                    Wingman Tunnel Helper                         ║
╚══════════════════════════════════════════════════════════════════╝${colors.reset}

${colors.bold}Detected Tools:${colors.reset}
`);

  for (const tool of tools) {
    const icon = tool.installed ? `${colors.green}✓${colors.reset}` : `${colors.dim}✗${colors.reset}`;
    const version = tool.version ? ` (${tool.version})` : '';
    console.log(`  ${icon} ${tool.name}${version}`);
  }

  if (!tools.some((t) => t.installed)) {
    console.log(`
${colors.yellow}No tunnel tools detected.${colors.reset} Install one of:
  • Tailscale: https://tailscale.com/download
  • cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
`);
  }

  console.log(`
${colors.bold}────────────────────────────────────────────────────────────────────${colors.reset}
${colors.bold}Recommended Tunnel Options (ranked by durability):${colors.reset}

Wingman is listening on ${colors.cyan}http://${host}:${port}/mcp${colors.reset}
`);

  let rank = 1;
  for (const cmd of commands) {
    const durabilityTag = formatDurability(cmd.durability);
    console.log(`${colors.bold}${rank}. ${cmd.tool}${colors.reset} [${durabilityTag}]`);
    console.log(`   ${colors.dim}${cmd.description}${colors.reset}`);
    console.log(`   ${colors.cyan}${cmd.command}${colors.reset}`);
    if (cmd.windowsNote) {
      console.log(`   ${colors.yellow}Windows: ${cmd.windowsNote}${colors.reset}`);
    }
    if (cmd.setupRequired && cmd.durability === 'stable') {
      console.log(`   ${colors.dim}Setup: See below for one-time configuration.${colors.reset}`);
    }
    console.log('');
    rank++;
  }

  if (state?.lastPublicUrl) {
    console.log(`${colors.bold}────────────────────────────────────────────────────────────────────${colors.reset}`);
    console.log(`${colors.bold}Last Known Tunnel:${colors.reset}`);
    console.log(`  URL: ${colors.cyan}${state.lastPublicUrl}${colors.reset}`);
    console.log(`  Updated: ${state.updatedAt}`);
    console.log('');
  }

  console.log(`${colors.bold}────────────────────────────────────────────────────────────────────${colors.reset}`);
  console.log(`${colors.bold}Quick Reference:${colors.reset}

${colors.bold}Best for:${colors.reset}
  • ${colors.green}Personal/team use${colors.reset} → Tailscale Serve (loopback to your network)
  • ${colors.green}Public sharing${colors.reset} → Tailscale Funnel (stable public URL)
  • ${colors.green}Custom domain${colors.reset} → Cloudflare Named Tunnel (requires DNS setup)
  • ${colors.yellow}Quick demos${colors.reset} → Cloudflare Quick Tunnel (URL changes each restart)

${colors.bold}After starting a tunnel:${colors.reset}
  1. Copy the tunnel URL (e.g., https://abc.trycloudflare.com)
  2. Add /mcp to get the MCP endpoint: https://abc.trycloudflare.com/mcp
  3. Configure your MCP host with:
     • URL: <tunnel-url>/mcp
     • Authorization: Bearer <your-token>

${colors.bold}Token location:${colors.reset} ${config ? `${colors.cyan}~/.wingman/config.json${colors.reset}` : `${colors.yellow}Not configured yet. Run wingman-pair first.${colors.reset}`}

${colors.bold}Security:${colors.reset} See SECURITY.md for token rotation and best practices.
`);

  printNamedTunnelSetup(port);
}

function printNamedTunnelSetup(port: number): void {
  const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
  };

  console.log(`${colors.bold}────────────────────────────────────────────────────────────────────${colors.reset}`);
  console.log(`${colors.bold}Named Cloudflare Tunnel Setup (one-time):${colors.reset}

If you want a stable Cloudflare hostname:

${colors.cyan}# 1. Authenticate (opens browser)
cloudflared tunnel login

# 2. Create a named tunnel
cloudflared tunnel create wingman

# 3. Route DNS (replace <YOUR_DOMAIN>)
cloudflared tunnel route dns wingman wingman.<YOUR_DOMAIN>

# 4. Create config file
# Linux/macOS: ~/.cloudflared/config.yml
# Windows: %USERPROFILE%\\.cloudflared\\config.yml${colors.reset}

${colors.dim}tunnel: <TUNNEL_ID_FROM_STEP_2>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: wingman.<YOUR_DOMAIN>
    service: http://localhost:${port}
  - service: http_status:404${colors.reset}

${colors.cyan}# 5. Run the tunnel
cloudflared tunnel run wingman${colors.reset}

Your stable URL will be: https://wingman.<YOUR_DOMAIN>/mcp
`);
}

export function recordTunnelUrl(url: string, tunnelType?: TunnelRecommendation): void {
  saveTunnelState({
    lastPublicUrl: url,
    lastTunnelType: tunnelType || 'unknown',
  });
  console.log(`[wingman] Tunnel URL recorded: ${url}`);
}

/** Save the MagicDNS name so the next process allowlists it, and record the connector URL. */
export function rememberFunnelHost(dnsName: string): string {
  const host = dnsName.trim().replace(/\.$/, '');
  const url = funnelConnectorUrl(host);
  recordTunnelUrl(url, 'tailscale-funnel');
  const cfg = loadConfig();
  if (cfg && cfg.tunnelHost !== host) {
    saveConfig({ ...cfg, tunnelHost: host });
  }
  return url;
}

/** Record a quick-tunnel connector URL and allowlist its hostname. */
export function rememberQuickHost(url: string): string {
  const connector = url.endsWith('/mcp') ? url : `${url.replace(/\/$/, '')}/mcp`;
  const host = hostnameFromUrl(connector);
  recordTunnelUrl(connector, 'quick-tunnel');
  const cfg = loadConfig();
  if (cfg && host && cfg.tunnelHost !== host) {
    saveConfig({ ...cfg, tunnelHost: host });
  }
  return connector;
}

export function probeHttp(url: string, timeoutMs = 3000): Promise<{ status?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      parsed,
      { method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 2000),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'ETIMEDOUT' });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.end();
  });
}

export async function diagnoseTunnel(opts: {
  publicUrl?: string;
  localUrl: string;
  funnel?: FunnelDiagnosis;
}): Promise<unknown> {
  const local = await probeHttp(opts.localUrl);
  const remote = opts.publicUrl ? await probeHttp(opts.publicUrl) : undefined;
  const beat = readHeartbeat();
  const report = diagnoseLocal({
    localHttpStatus: local.status,
    localError: local.error,
    heartbeatAgeMs: heartbeatAgeMs(beat),
    publicStatus: remote?.status,
    publicError: remote?.error,
    publicBody: remote?.body,
  });
  const heartbeat = describeHeartbeat(report.heartbeatAgeMs ?? null);
  return { ...report, ...heartbeat, funnel: opts.funnel };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: wingman-tunnel [options]

Options:
  --help, -h          Show this help message
  --record-url URL    Record a tunnel URL for future reference
  --show-state        Show saved tunnel state
  diagnose            Probe local Wingman, Funnel status, and an optional public URL
  classify            Classify a remote error without a live server
  tailscale           Run tailscale funnel --bg and print the stable https URL
  --tailscale         Same as the tailscale subcommand

tailscale options:
  --port PORT         Local port to publish (default from config, else 3847)
  --bin PATH          Path to tailscale, or tailscale.exe on Windows
                      Also read from WINGMAN_TAILSCALE_PATH

diagnose options:
  --url URL           Public tunnel URL to probe (healthz path is added if missing)
  --local URL         Local health URL (default http://127.0.0.1:<port>/healthz)

classify options:
  --status N          HTTP status from the failed client call
  --error TEXT        Client error message, such as "fetch failed"
  --body TEXT         Response body, such as a Cloudflare 1033 page

Detects available tunnel tools and prints recommended commands.
A failed MCP call cannot ask Wingman what broke. Use diagnose on the machine,
or classify the HTTP error on the client.
`);
    return;
  }

  if (args[0] === 'tailscale' || args.includes('--tailscale')) {
    const config = loadConfig();
    const portIdx = args.indexOf('--port');
    const binIdx = args.indexOf('--bin');
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : (config?.port ?? resolvePort());
    const bin = resolveTailscaleBin({
      explicit: binIdx >= 0 ? args[binIdx + 1] : undefined,
      env: process.env.WINGMAN_TAILSCALE_PATH,
      configBin: config?.tailscaleBin,
    });
    const diagnosis = executeFunnel({ port, bin, run: spawnCommandRunner() });
    if (diagnosis.dnsName && (diagnosis.active || diagnosis.started)) {
      try {
        diagnosis.connectorUrl = rememberFunnelHost(diagnosis.dnsName);
      } catch (err) {
        diagnosis.summary += ` (could not save the hostname: ${err instanceof Error ? err.message : err})`;
      }
    }
    console.log(JSON.stringify({ ...diagnosis, port, bin }, null, 2));
    if (!diagnosis.active && !diagnosis.started) process.exitCode = 1;
    return;
  }

  if (args[0] === 'classify') {
    const statusIdx = args.indexOf('--status');
    const errorIdx = args.indexOf('--error');
    const bodyIdx = args.indexOf('--body');
    const status = statusIdx >= 0 ? Number(args[statusIdx + 1]) : undefined;
    const report = classifyRemoteFailure({
      httpStatus: status !== undefined && Number.isFinite(status) ? status : undefined,
      errorMessage: errorIdx >= 0 ? args[errorIdx + 1] : undefined,
      body: bodyIdx >= 0 ? args[bodyIdx + 1] : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args[0] === 'diagnose') {
    const config = loadConfig();
    const port = config?.port ?? resolvePort();
    const urlIdx = args.indexOf('--url');
    const localIdx = args.indexOf('--local');
    let publicUrl = urlIdx >= 0 ? args[urlIdx + 1] : undefined;
    if (publicUrl && !/\/healthz$/.test(publicUrl)) {
      publicUrl = `${publicUrl.replace(/\/$/, '')}/healthz`;
    }
    const localUrl = localIdx >= 0 ? args[localIdx + 1] : `http://127.0.0.1:${port}/healthz`;
    const bin = resolveTailscaleBin({
      env: process.env.WINGMAN_TAILSCALE_PATH,
      configBin: config?.tailscaleBin,
    });
    const funnel = readFunnelDiagnosis({ port, bin, run: spawnCommandRunner() });
    const report = await diagnoseTunnel({ publicUrl, localUrl: localUrl!, funnel });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.includes('--show-state')) {
    const state = loadTunnelState();
    if (state) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log('No tunnel state saved yet.');
    }
    return;
  }

  const recordIdx = args.indexOf('--record-url');
  if (recordIdx !== -1 && args[recordIdx + 1]) {
    recordTunnelUrl(args[recordIdx + 1]);
    return;
  }

  printTunnelHelp();
}

const isMain =
  process.argv[1]?.endsWith('tunnel.ts') ||
  process.argv[1]?.endsWith('tunnel.js') ||
  process.argv[1]?.includes('/tunnel');

if (isMain) {
  main().catch((err) => {
    console.error(safeErrorText(err, [loadConfig()?.token]));
    process.exit(1);
  });
}
