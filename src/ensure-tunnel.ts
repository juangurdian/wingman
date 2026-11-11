/**
 * Bring up the tunnel the scheduled task asked for.
 * Tailscale Funnel --bg persists in tailscaled, so this only republishes the port
 * when the status check says it is not active. A quick tunnel is a process and
 * must be started again after each boot. Its hostname changes every start.
 * The quick-tunnel URL is read from cloudflared before this reports success.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { loadConfig } from './config.js';
import type { SpawnPlan } from './spawn-command.js';
import { rememberFunnelHost, rememberQuickHost } from './tunnel.js';
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

export interface QuickSpawnResult {
  pid?: number;
  connectorUrl?: string;
  error?: string;
}

const TRY_CLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function ensureConfiguredTunnel(opts: {
  mode: 'none' | 'tailscale' | 'quick';
  port: number;
  host: string;
  tailscaleBin?: string;
  run?: CommandRunner;
  spawnQuick?: (plan: SpawnPlan) => QuickSpawnResult | Promise<QuickSpawnResult>;
}): Promise<EnsureTunnelResult> {
  if (opts.mode === 'none') {
    return { mode: 'none', summary: 'No tunnel check requested.' };
  }
  if (opts.mode === 'quick') {
    const plan = quickTunnelPlan(opts.host, opts.port, process.env.WINGMAN_CLOUDFLARED_PATH?.trim() || 'cloudflared');
    const child = await (opts.spawnQuick ?? defaultSpawnQuick)(plan);
    if (child.error || !child.connectorUrl) {
      return {
        mode: 'quick',
        summary: child.error
          ? `Cloudflare quick tunnel did not start: ${child.error}`
          : 'Cloudflare quick tunnel did not print a trycloudflare.com URL.',
      };
    }
    let connectorUrl = child.connectorUrl;
    try {
      connectorUrl = rememberQuickHost(connectorUrl);
    } catch {
      /* the bridge can still listen if the config dir is not writable */
    }
    return {
      mode: 'quick',
      summary:
        `Started a Cloudflare quick tunnel (pid ${child.pid ?? 'unknown'}) at ${connectorUrl}. ` +
        'The trycloudflare.com hostname changes every start. Tailscale Funnel is the stable URL.',
      connectorUrl,
    };
  }
  const bin = resolveTailscaleBin({
    explicit: opts.tailscaleBin,
    env: process.env.WINGMAN_TAILSCALE_PATH,
    configBin: loadConfig()?.tailscaleBin,
    platform: process.platform,
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

function defaultSpawnQuick(plan: SpawnPlan): Promise<QuickSpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(plan.command, plan.args, {
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch (err) {
      resolve({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const finish = (result: QuickSpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.connectorUrl) child.kill();
      else child.unref();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ error: 'cloudflared did not print a trycloudflare.com URL' });
    }, 20_000);

    child.once('error', (err) => {
      finish({ error: err.message });
    });
    child.once('exit', (code) => {
      finish({ error: `cloudflared exited (${code ?? 'unknown'}) before printing a tunnel URL` });
    });

    const onData = (buf: Buffer) => {
      const match = buf.toString().match(TRY_CLOUDFLARE);
      if (!match) return;
      const discard = () => {};
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.stdout?.on('data', discard);
      child.stderr?.on('data', discard);
      finish({ pid: child.pid, connectorUrl: `${match[0]}/mcp` });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
}
