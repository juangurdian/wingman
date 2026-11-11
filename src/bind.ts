/**
 * Listen address and DNS rebinding allowlist.
 *
 * The MCP SDK turns host checks on when `allowedHosts` is set. Loopback is the
 * default listen address. A Tailscale Funnel or other tunnel still works because
 * its hostname is on the allowlist. The Host header is not the bind address.
 */

import { loadConfig } from './config.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export function hostnameFromUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim();
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const hostname = new URL(withScheme).hostname.replace(/\.$/, '');
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

export function splitHostList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[,\s]+/)
    .map((part) => hostnameFromUrl(part) ?? part.trim())
    .map((part) => part.replace(/\.$/, ''))
    .filter((part) => part.length > 0 && part !== '0.0.0.0' && part !== '::');
}

/**
 * Hostnames the DNS rebinding check accepts.
 * Always includes loopback. Adds the tunnel or Tailscale name from config, env, or a public URL.
 */
export function collectAllowedHosts(input?: {
  listenHost?: string;
  tunnelHost?: string;
  publicUrl?: string;
  extra?: string[];
  configTunnelHost?: string;
  envAllowed?: string;
  envTunnelHost?: string;
}): string[] {
  const listen = input?.listenHost?.trim();
  const pieces = [
    ...LOCAL_HOSTS,
    listen && listen !== '0.0.0.0' && listen !== '::' ? listen : undefined,
    input?.configTunnelHost,
    input?.tunnelHost,
    input?.envTunnelHost,
    hostnameFromUrl(input?.publicUrl),
    ...(input?.extra ?? []),
    ...splitHostList(input?.envAllowed),
  ];
  const hosts: string[] = [];
  for (const piece of pieces) {
    const host = piece?.trim().replace(/\.$/, '');
    if (!host || host === '0.0.0.0' || host === '::') continue;
    const normalized = host.includes(':') && !host.startsWith('[') ? hostnameFromUrl(host) ?? host : host;
    if (!hosts.includes(normalized)) hosts.push(normalized);
  }
  return hosts;
}

/**
 * Allowlist whose `includes` reads config and tunnel state on every request.
 * The MCP SDK stores the array it is given, so a Funnel hostname saved after
 * listen still passes the Host check without a restart.
 */
export class RefreshingAllowList extends Array<string> {
  constructor(private readonly current: () => readonly string[]) {
    super();
    Object.setPrototypeOf(this, RefreshingAllowList.prototype);
  }

  override includes(search: string, fromIndex?: number): boolean {
    return this.current().includes(search, fromIndex);
  }
}

export function liveAllowedHosts(listenHost: string, readPublicUrl?: () => string | undefined): string[] {
  return new RefreshingAllowList(() => allowedHostsForListen(listenHost, readPublicUrl?.()));
}

/** Allowed hosts for the process that is about to listen. */
export function allowedHostsForListen(listenHost: string, publicUrl?: string): string[] {
  const config = loadConfig();
  return collectAllowedHosts({
    listenHost,
    configTunnelHost: config?.tunnelHost,
    envAllowed: process.env.WINGMAN_ALLOWED_HOSTS,
    envTunnelHost: process.env.WINGMAN_TUNNEL_HOST,
    publicUrl,
  });
}

/**
 * Options for `createMcpExpressApp`.
 * `allowedHosts` is always set, including when the listen address is 0.0.0.0,
 * so the SDK does not skip DNS rebinding protection.
 */
export function mcpExpressOptions(listenHost: string, allowedHosts: string[]): {
  host: string;
  allowedHosts: string[];
} {
  return {
    host: listenHost,
    allowedHosts,
  };
}
