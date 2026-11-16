/**
 * Tailscale Funnel helpers.
 *
 * `tailscale funnel --bg` stores the config in tailscaled, so a later boot
 * only needs to check that the funnel is still active. The MagicDNS name comes
 * from `tailscale status --json` (Self.DNSName) and does not change when the
 * machine reboots.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commandSpawnPlan, type SpawnPlan } from './spawn-command.js';

export const FUNNEL_NOT_ENABLED = 'Funnel not enabled on tailnet';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export interface FunnelDiagnosis {
  checked: boolean;
  enabled: boolean;
  active?: boolean;
  started?: boolean;
  dnsName?: string;
  connectorUrl?: string;
  summary: string;
  approvalUrl?: string;
}

export function funnelConnectorUrl(dnsName: string, path = '/mcp'): string {
  const host = dnsName.trim().replace(/\.$/, '').replace(/^https?:\/\//, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `https://${host}${suffix}`;
}

export function parseTailscaleStatus(json: string): { dnsName?: string; online?: boolean } {
  try {
    const data = JSON.parse(json) as { Self?: { DNSName?: unknown; Online?: unknown } };
    const raw = data.Self?.DNSName;
    const dnsName = typeof raw === 'string' ? raw.trim().replace(/\.$/, '') : undefined;
    return {
      dnsName: dnsName || undefined,
      online: typeof data.Self?.Online === 'boolean' ? data.Self.Online : undefined,
    };
  } catch {
    return {};
  }
}

export function parseFunnelFailure(text: string): { notEnabled: boolean; approvalUrl?: string } {
  const notEnabled = /funnel (is )?not enabled/i.test(text);
  const match = text.match(/https:\/\/login\.tailscale\.com\/\S+/);
  const approvalUrl = match?.[0]?.replace(/[)\].,>'"]+$/, '');
  return { notEnabled, approvalUrl };
}

function proxyStringMatches(value: string, port: number): boolean {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = trimmed.includes('://') ? new URL(trimmed) : new URL(`http://${trimmed}`);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
  const parsed = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return parsed === port;
}

function objectProxiesPort(node: Record<string, unknown>, port: number): boolean {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && /^proxy$/i.test(key) && proxyStringMatches(value, port)) return true;
    if (key === 'Handlers' && value && typeof value === 'object') {
      for (const handler of Object.values(value as Record<string, unknown>)) {
        if (handler && typeof handler === 'object' && objectProxiesPort(handler as Record<string, unknown>, port)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * True when one service both proxies this local port and has Funnel permission.
 * The port is parsed, so 3847 does not match 38470, and another service's
 * AllowFunnel flag does not count.
 */
export function proxiesPort(statusJson: string, port: number): boolean {
  let data: unknown;
  try {
    data = JSON.parse(statusJson);
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object') return false;
  const allow = (data as { AllowFunnel?: unknown }).AllowFunnel;
  const allowMap =
    allow && typeof allow === 'object' ? (allow as Record<string, unknown>) : {};

  const walk = (node: unknown, key: string | undefined): boolean => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const obj = node as Record<string, unknown>;
    if (key && objectProxiesPort(obj, port) && (allowMap[key] === true || obj.AllowFunnel === true)) {
      return true;
    }
    for (const [childKey, child] of Object.entries(obj)) {
      if (childKey === 'AllowFunnel') continue;
      if (walk(child, childKey)) return true;
    }
    return false;
  };

  return walk(data, undefined);
}

export function resolveTailscaleBin(opts?: {
  explicit?: string;
  env?: string;
  configBin?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}): string {
  if (opts?.explicit?.trim()) return opts.explicit.trim();
  if (opts?.env?.trim()) return opts.env.trim();
  if (opts?.configBin?.trim()) return opts.configBin.trim();
  const platform = opts?.platform ?? process.platform;
  const exists = opts?.exists ?? existsSync;
  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const candidate = `${programFiles}\\Tailscale\\tailscale.exe`;
    if (exists(candidate)) return candidate;
  }
  return 'tailscale';
}

export function readFunnelDiagnosis(opts: {
  port: number;
  bin: string;
  run: CommandRunner;
}): FunnelDiagnosis {
  const status = opts.run(opts.bin, ['status', '--json']);
  if (status.error && /ENOENT|not found/i.test(status.error)) {
    return { checked: false, enabled: false, summary: 'tailscale is not installed' };
  }
  const dnsName = parseTailscaleStatus(status.stdout).dnsName;
  const funnel = opts.run(opts.bin, ['funnel', 'status']);
  const failureText = `${funnel.stdout}\n${funnel.stderr}\n${status.stderr}`;
  const failure = parseFunnelFailure(failureText);
  if (failure.notEnabled) {
    return notEnabledDiagnosis(dnsName, failure.approvalUrl);
  }
  const serve = opts.run(opts.bin, ['serve', 'status', '--json']);
  const serveFailure = parseFunnelFailure(`${serve.stdout}\n${serve.stderr}`);
  if (serveFailure.notEnabled) {
    return notEnabledDiagnosis(dnsName, serveFailure.approvalUrl ?? failure.approvalUrl);
  }
  const active = proxiesPort(serve.stdout, opts.port);
  const connectorUrl = dnsName ? funnelConnectorUrl(dnsName) : undefined;
  if (funnel.status !== 0 && serve.status !== 0 && !active) {
    const detail = (funnel.stderr || funnel.stdout || serve.stderr || 'Funnel status command failed.').trim();
    return {
      checked: true,
      enabled: true,
      active: false,
      dnsName,
      connectorUrl,
      summary: detail,
    };
  }
  return {
    checked: true,
    enabled: true,
    active,
    dnsName,
    connectorUrl,
    summary: active
      ? `Funnel is active for port ${opts.port}${connectorUrl ? ` at ${connectorUrl}` : ''}.`
      : `Tailscale is installed${dnsName ? ` as ${dnsName}` : ''}. Funnel is not currently proxying port ${opts.port}.`,
  };
}

function notEnabledDiagnosis(dnsName: string | undefined, approvalUrl?: string): FunnelDiagnosis {
  return {
    checked: true,
    enabled: false,
    active: false,
    dnsName,
    summary: approvalUrl ? `${FUNNEL_NOT_ENABLED}. Approve it at ${approvalUrl}` : FUNNEL_NOT_ENABLED,
    approvalUrl,
  };
}

/**
 * Check Funnel, and run `tailscale funnel --bg <port>` when this port is not already published.
 * `--bg` persists in tailscaled, so the next check is a no-op while it stays active.
 */
export function executeFunnel(opts: { port: number; bin: string; run: CommandRunner }): FunnelDiagnosis {
  const current = readFunnelDiagnosis(opts);
  if (!current.checked || current.enabled === false) {
    return { ...current, started: false };
  }
  if (current.active && current.connectorUrl) {
    return { ...current, started: false };
  }
  const started = opts.run(opts.bin, ['funnel', '--bg', String(opts.port)]);
  const failure = parseFunnelFailure(`${started.stdout}\n${started.stderr}`);
  if (failure.notEnabled) {
    return { ...notEnabledDiagnosis(current.dnsName, failure.approvalUrl), started: false };
  }
  if (started.status !== 0) {
    return {
      checked: true,
      enabled: true,
      active: false,
      started: false,
      dnsName: current.dnsName,
      connectorUrl: current.connectorUrl,
      summary: (started.stderr || started.stdout || 'tailscale funnel --bg failed').trim(),
    };
  }
  const again = readFunnelDiagnosis(opts);
  const active = again.active === true;
  const dnsName = again.dnsName ?? current.dnsName;
  const connectorUrl = again.connectorUrl ?? (dnsName ? funnelConnectorUrl(dnsName) : current.connectorUrl);
  return {
    ...again,
    started: true,
    active,
    dnsName,
    connectorUrl,
    summary: active
      ? `Funnel is active for port ${opts.port}${connectorUrl ? ` at ${connectorUrl}` : ''}.`
      : `tailscale funnel --bg ${opts.port} exited 0. ${again.summary}`,
  };
}

export function spawnCommandRunner(): CommandRunner {
  return (command, args) => {
    const plan = commandSpawnPlan(command, args);
    const result = spawnSync(plan.command, plan.args, {
      encoding: 'utf8',
      timeout: 15000,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`,
      error: result.error?.message,
    };
  };
}

export function quickTunnelPlan(host: string, port: number, bin = 'cloudflared'): SpawnPlan {
  return commandSpawnPlan(bin, ['tunnel', '--url', `http://${host}:${port}`]);
}
