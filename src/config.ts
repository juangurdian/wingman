import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface BridgeConfig {
  token: string;
  host: string;
  port: number;
  mcpPath: string;
  createdAt: string;
  mock?: boolean;
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
