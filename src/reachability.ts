/**
 * Tell a remote supervisor apart from three different failures:
 * the host is offline, the tunnel is down, or Wingman itself is down.
 *
 * An MCP tool cannot answer after this process exits. The rules below are
 * what the client applies to its own HTTP error, and what `wingman-tunnel diagnose`
 * applies when it can still run on the machine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.js';

export type RemoteState =
  | 'server_up'
  | 'auth_rejected'
  | 'tunnel_down'
  | 'server_down'
  | 'host_offline'
  | 'unknown';

export interface RemoteClassification {
  state: RemoteState;
  summary: string;
}

const TUNNEL_DOWN =
  'tunnel_down: Cloudflare has no connected cloudflared (error 1033 or HTTP 530). The machine may be asleep, or the tunnel process stopped. This is not proof that the Wingman process crashed.';

const SERVER_DOWN =
  'server_down: the tunnel reached Cloudflare, but the Wingman process is not accepting connections (HTTP 502 or 504).';

const HOST_OFFLINE =
  'host_offline: the client never reached the tunnel hostname (DNS failure, timeout, or fetch failed with no HTTP status).';

export function classifyRemoteFailure(input: {
  httpStatus?: number;
  errorMessage?: string;
  body?: string;
}): RemoteClassification {
  const status = input.httpStatus;
  const blob = `${input.errorMessage ?? ''}\n${input.body ?? ''}`;

  if (status === 200) {
    return { state: 'server_up', summary: 'server_up: Wingman answered /healthz.' };
  }
  if (status === 401 || status === 403) {
    return {
      state: 'auth_rejected',
      summary:
        'auth_rejected: Wingman is up and refused the bearer token. This is not a crash, a tunnel outage, or a sleeping host.',
    };
  }
  if (status === 530 || /\b1033\b|cloudflare tunnel error|tunnel (is )?not connected/i.test(blob)) {
    return { state: 'tunnel_down', summary: TUNNEL_DOWN };
  }
  if (status === 502 || status === 504 || /bad gateway|origin is unreachable|error code:\s*502/i.test(blob)) {
    return { state: 'server_down', summary: SERVER_DOWN };
  }
  if (/ECONNREFUSED/i.test(blob)) {
    return {
      state: 'server_down',
      summary:
        'server_down: a host accepted the route and refused the port. Wingman is not listening. The machine itself answered, so this is not host_offline.',
    };
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|getaddrinfo|network error|Failed to fetch|EHOSTUNREACH|ENETUNREACH/i.test(
      blob,
    )
  ) {
    return { state: 'host_offline', summary: HOST_OFFLINE };
  }
  if (status === undefined && !blob.trim()) {
    return { state: 'unknown', summary: 'unknown: no status and no error text.' };
  }
  return {
    state: 'unknown',
    summary: 'unknown: the failure does not match host_offline, tunnel_down, or server_down.',
  };
}

export interface LocalDiagnosis extends RemoteClassification {
  /** True when this report was produced on the machine itself. */
  hostOnline: true;
  serverListening: boolean;
  tunnel?: RemoteClassification;
  heartbeatAgeMs?: number | null;
  heartbeatStale?: boolean;
  heartbeatWarning?: string;
}

/**
 * Combine a local port probe with an optional public URL probe.
 * Running this function means the host is on. host_offline is only for remote clients.
 */
export function diagnoseLocal(input: {
  localHttpStatus?: number;
  localError?: string;
  heartbeatAgeMs?: number | null;
  publicStatus?: number;
  publicError?: string;
  publicBody?: string;
}): LocalDiagnosis {
  const localUp = input.localHttpStatus === 200;
  const tunnel =
    input.publicStatus !== undefined || input.publicError || input.publicBody
      ? classifyRemoteFailure({
          httpStatus: input.publicStatus,
          errorMessage: input.publicError,
          body: input.publicBody,
        })
      : undefined;

  const beat = describeHeartbeat(input.heartbeatAgeMs ?? null);
  const beatFields = {
    heartbeatAgeMs: beat.heartbeatAgeMs,
    heartbeatStale: beat.heartbeatStale,
    heartbeatWarning: beat.heartbeatWarning,
  };

  if (localUp && tunnel?.state === 'tunnel_down') {
    return {
      state: 'tunnel_down',
      summary:
        'tunnel_down: Wingman is listening locally, and the public URL is Cloudflare 1033 or HTTP 530. Restart cloudflared or Tailscale. The Wingman process has not crashed.',
      hostOnline: true,
      serverListening: true,
      tunnel,
      ...beatFields,
    };
  }

  if (localUp) {
    return {
      state: 'server_up',
      summary: tunnel
        ? `server_up: local /healthz answered. Public probe: ${tunnel.summary}`
        : 'server_up: local /healthz answered.',
      hostOnline: true,
      serverListening: true,
      tunnel,
      ...beatFields,
    };
  }

  const heartbeat =
    input.heartbeatAgeMs == null
      ? 'No heartbeat file. Wingman may never have started on this boot.'
      : `Last heartbeat was ${input.heartbeatAgeMs}ms ago.`;

  if (tunnel?.state === 'server_down') {
    return {
      state: 'server_down',
      summary: `server_down: the tunnel is up and the local port is closed. ${heartbeat}`,
      hostOnline: true,
      serverListening: false,
      tunnel,
      ...beatFields,
    };
  }

  if (tunnel?.state === 'tunnel_down') {
    return {
      state: 'server_down',
      summary: `server_down: Wingman is not listening, and the tunnel is disconnected too. A remote client sees Cloudflare 1033 or fetch failed, which hides the crash. ${heartbeat}`,
      hostOnline: true,
      serverListening: false,
      tunnel,
      ...beatFields,
    };
  }

  return {
    state: 'server_down',
    summary: `server_down: local /healthz did not answer. ${input.localError ? input.localError + '. ' : ''}${heartbeat}`,
    hostOnline: true,
    serverListening: false,
    tunnel,
    ...beatFields,
  };
}

export interface Heartbeat {
  pid: number;
  port: number;
  startedAt: string;
  beatAt: string;
}

export function heartbeatPath(): string {
  return join(configDir(), 'heartbeat.json');
}

export function writeHeartbeat(info: { pid: number; port: number; startedAt: string }): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const beat: Heartbeat = { ...info, beatAt: new Date().toISOString() };
  writeFileSync(heartbeatPath(), `${JSON.stringify(beat, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function readHeartbeat(): Heartbeat | null {
  const path = heartbeatPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Heartbeat;
  } catch {
    return null;
  }
}

export function heartbeatAgeMs(beat: Heartbeat | null, now = Date.now()): number | null {
  if (!beat?.beatAt) return null;
  const then = Date.parse(beat.beatAt);
  if (Number.isNaN(then)) return null;
  return Math.max(0, now - then);
}

/** A beat older than this means the process is stopped, hung, or the machine slept. */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export interface HeartbeatReport {
  heartbeatAgeMs: number | null;
  heartbeatStale: boolean;
  heartbeatWarning?: string;
}

/**
 * heartbeat.json is rewritten about every 15 seconds while Wingman is running.
 * Older than 5 minutes means that process is not writing beats. It does not by
 * itself mean the tunnel is down. After a reboot, a stale or missing file means
 * nothing restarted Wingman.
 */
export function describeHeartbeat(ageMs: number | null, staleAfterMs = HEARTBEAT_STALE_MS): HeartbeatReport {
  if (ageMs == null) {
    return {
      heartbeatAgeMs: null,
      heartbeatStale: true,
      heartbeatWarning:
        'No heartbeat.json. Wingman is not recording beats. It may never have started on this boot, or the file was removed. A missing beat does not by itself mean the tunnel is down.',
    };
  }
  if (ageMs > staleAfterMs) {
    return {
      heartbeatAgeMs: ageMs,
      heartbeatStale: true,
      heartbeatWarning:
        `heartbeat.json is ${ageMs}ms old, past the ${staleAfterMs}ms stale limit. The file is rewritten about every 15 seconds while Wingman is running, so the process is stopped, hung, or the machine slept and nothing wrote a new beat. This does not by itself mean the tunnel is down.`,
    };
  }
  return { heartbeatAgeMs: ageMs, heartbeatStale: false };
}

export interface BridgeStatus {
  ok: true;
  service: 'wingman';
  state: 'server_up';
  pid: number;
  uptimeMs: number;
  version: string;
  port?: number;
  /** How a remote client should read a failed call. This process cannot say it once it is dead. */
  heartbeatAgeMs: number | null;
  heartbeatStale: boolean;
  /** Set when the on-disk beat is missing or older than 5 minutes. */
  heartbeatWarning?: string;
  ifUnreachable: {
    cloudflare_1033_or_http_530: string;
    http_502_or_504: string;
    fetch_failed_or_dns: string;
    http_401_or_403: string;
  };
}

export function buildBridgeStatus(input: {
  pid: number;
  startedAtMs: number;
  now?: number;
  port?: number;
  version?: string;
  /** Pass null when the file is missing. Omit to read ~/.wingman/heartbeat.json. */
  heartbeatAgeMs?: number | null;
}): BridgeStatus {
  const now = input.now ?? Date.now();
  const age =
    input.heartbeatAgeMs !== undefined ? input.heartbeatAgeMs : heartbeatAgeMs(readHeartbeat(), now);
  const beat = describeHeartbeat(age);
  return {
    ok: true,
    service: 'wingman',
    state: 'server_up',
    pid: input.pid,
    uptimeMs: Math.max(0, now - input.startedAtMs),
    version: input.version ?? '0.2.0',
    port: input.port,
    heartbeatAgeMs: beat.heartbeatAgeMs,
    heartbeatStale: beat.heartbeatStale,
    heartbeatWarning: beat.heartbeatWarning,
    ifUnreachable: {
      cloudflare_1033_or_http_530: TUNNEL_DOWN,
      http_502_or_504: SERVER_DOWN,
      fetch_failed_or_dns: HOST_OFFLINE,
      http_401_or_403:
        'auth_rejected: Wingman is up. The bearer token is missing or wrong.',
    },
  };
}
