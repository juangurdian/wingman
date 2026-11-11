/**
 * Bring up the tunnel the scheduled task asked for.
 * Tailscale Funnel --bg persists in tailscaled, so this only republishes the port
 * when the status check says it is not active. A quick tunnel is a process and
 * must be started again after each boot. Its hostname changes every start.
 */

import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { rememberFunnelHost } from './tunnel.js';
import {
  executeFunnel,
  quickTunnelPlan,
  resolveTailscaleBin,
  spawnCommandRunner,
  type CommandRunner,
} from './tailscale.js';

export interface EnsureTunnelResult {
  mode: 'none' | 'tailscale' | 'quick';
  summary: string;
  connectorUrl?: string;
}

export function ensureConfiguredTunnel(opts: {
  mode: 'none' | 'tailscale' | 'quick';
  port: number;
  host: string;
  tailscaleBin?: string;
  run?: CommandRunner;
  spawnQuick?: (plan: { command: string; args: string[]; shell: false }) => { pid?: number };
}): EnsureTunnelResult {
  if (opts.mode === 'none') {
    return { mode: 'none', summary: 'No tunnel check requested.' };
  }
  if (opts.mode === 'quick') {
    const plan = quickTunnelPlan(opts.host, opts.port, process.env.WINGMAN_CLOUDFLARED_PATH?.trim() || 'cloudflared');
    const child = (opts.spawnQuick ?? defaultSpawnQuick)(plan);
    return {
      mode: 'quick',
      summary:
        `Started a Cloudflare quick tunnel (pid ${child.pid ?? 'unknown'}) with shell:false. ` +
        'The trycloudflare.com hostname changes every start. Tailscale Funnel is the stable URL.',
    };
  }
  const bin = resolveTailscaleBin({
    explicit: opts.tailscaleBin,
    env: process.env.WINGMAN_TAILSCALE_PATH,
    configBin: loadConfig()?.tailscaleBin,
  });
  const diagnosis = executeFunnel({
    port: opts.port,
    bin,
    run: opts.run ?? spawnCommandRunner(),
  });
  let connectorUrl = diagnosis.connectorUrl;
  if (diagnosis.dnsName && (diagnosis.active || diagnosis.started)) {
    try {
      connectorUrl = rememberFunnelHost(diagnosis.dnsName);
    } catch {
      /* the bridge can still listen if the config dir is not writable */
    }
  }
  return { mode: 'tailscale', summary: diagnosis.summary, connectorUrl };
}

function defaultSpawnQuick(plan: { command: string; args: string[]; shell: false }): { pid?: number } {
  const child = spawn(plan.command, plan.args, {
    shell: false,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid };
}
