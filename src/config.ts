import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface BridgeConfig {
  token: string;
  host: string;
  port: number;
  mcpPath: string;
  createdAt: string;
  mock?: boolean;
  /** Host identifier for multi-host setups (e.g., 'pearlwolf', 'macbook-pro') */
  hostId?: string;
  /** Human-friendly host name for display (e.g., 'Pearlwolf Windows', 'MacBook Pro') */
  hostName?: string;
}

/** Preferred config directory (~/.wingman). */
export function configDir(): string {
  return join(homedir(), '.wingman');
}

/** Legacy session-bridge config dir — still read as fallback. */
export function legacyConfigDir(): string {
  return join(homedir(), '.session-bridge');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

function legacyConfigPath(): string {
  return join(legacyConfigDir(), 'config.json');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function loadConfig(): BridgeConfig | null {
  for (const path of [configPath(), legacyConfigPath()]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as BridgeConfig;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function saveConfig(config: BridgeConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

function envFirst(...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function resolvePort(explicit?: number): number {
  if (explicit && Number.isFinite(explicit)) return explicit;
  const env = envFirst('WINGMAN_PORT', 'SESSION_BRIDGE_PORT');
  if (env && /^\d+$/.test(env)) return Number(env);
  return 3847;
}

export function resolveHost(): string {
  return envFirst('WINGMAN_HOST', 'SESSION_BRIDGE_HOST') || '127.0.0.1';
}

export function resolveToken(): string | undefined {
  return envFirst('WINGMAN_TOKEN', 'SESSION_BRIDGE_TOKEN');
}

export function mcpUrl(host: string, port: number, path = '/mcp'): string {
  return `http://${host}:${port}${path}`;
}

// Timeout configuration with environment variable overrides

/** Default timeout for Claude send_message SDK calls (ms). */
export const CLAUDE_SEND_TIMEOUT_MS_DEFAULT = 120_000;

/** Default timeout for wait_turn polling (ms). */
export const WINGMAN_WAIT_TURN_TIMEOUT_MS_DEFAULT = 60_000;

/** Default poll interval for wait_turn (ms). */
export const WINGMAN_WAIT_TURN_POLL_MS_DEFAULT = 500;

export function resolveClaudeSendTimeoutMs(): number {
  const env = process.env.CLAUDE_SEND_TIMEOUT_MS?.trim();
  if (env && /^\d+$/.test(env)) return Number(env);
  return CLAUDE_SEND_TIMEOUT_MS_DEFAULT;
}

export function resolveWaitTurnTimeoutMs(): number {
  const env = process.env.WINGMAN_WAIT_TURN_TIMEOUT_MS?.trim();
  if (env && /^\d+$/.test(env)) return Number(env);
  return WINGMAN_WAIT_TURN_TIMEOUT_MS_DEFAULT;
}

export function resolveWaitTurnPollMs(): number {
  const env = process.env.WINGMAN_WAIT_TURN_POLL_MS?.trim();
  if (env && /^\d+$/.test(env)) return Number(env);
  return WINGMAN_WAIT_TURN_POLL_MS_DEFAULT;
}

// Health endpoint configuration

/** Whether /healthz requires bearer auth. Default: true (auth required). */
export function isHealthzAuthFree(): boolean {
  const env = process.env.WINGMAN_HEALTHZ_AUTH_FREE?.trim().toLowerCase();
  return env === '1' || env === 'true';
}

// Codex model configuration

/**
 * Models that historically required API access (not ChatGPT subscription).
 * This is an advisory list only — Wingman does NOT recommend specific fallback models.
 * Users should keep their chosen model if they have API access, or let Codex pick
 * its current default by unsetting `model` in ~/.codex/config.toml.
 */
export const CODEX_API_ONLY_MODELS = [
  'gpt-6-sol',
  'gpt-5-sol',
  'gpt-6',
  'gpt-5',
  'o3',
  'o3-mini',
];

/**
 * Resolve Codex model to use for new sessions.
 * Priority: explicit arg > WINGMAN_CODEX_MODEL env > undefined (use Codex default/config)
 * 
 * By default (undefined), Wingman does NOT override the model — it uses whatever
 * is configured in ~/.codex/config.toml or Codex's built-in defaults.
 */
export function resolveCodexModel(explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const env = process.env.WINGMAN_CODEX_MODEL?.trim();
  if (env) return env;
  return undefined;
}

/**
 * Check if a model historically required API access (not ChatGPT subscription).
 * This is advisory only — the list may be outdated as models evolve.
 */
export function isCodexModelApiOnly(model: string): boolean {
  const normalized = model.toLowerCase().trim();
  return CODEX_API_ONLY_MODELS.some(
    (m) => normalized === m.toLowerCase() || normalized.startsWith(`${m.toLowerCase()}-`)
  );
}

// Host identity configuration

/**
 * Resolve the host ID for this Wingman instance.
 * Priority: WINGMAN_HOST_ID env > hostname
 */
export function resolveHostId(): string {
  const env = process.env.WINGMAN_HOST_ID?.trim();
  if (env) return env;
  return hostname();
}

/**
 * Resolve the host name (human-friendly) for this Wingman instance.
 * Priority: WINGMAN_HOST_NAME env > WINGMAN_HOST_ID env > hostname
 */
export function resolveHostName(): string {
  const nameEnv = process.env.WINGMAN_HOST_NAME?.trim();
  if (nameEnv) return nameEnv;
  const idEnv = process.env.WINGMAN_HOST_ID?.trim();
  if (idEnv) return idEnv;
  return hostname();
}
