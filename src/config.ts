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

export function configDir(): string {
  return join(homedir(), '.session-bridge');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function loadConfig(): BridgeConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BridgeConfig;
  } catch {
    return null;
  }
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

export function resolvePort(explicit?: number): number {
  if (explicit && Number.isFinite(explicit)) return explicit;
  const env = process.env.SESSION_BRIDGE_PORT;
  if (env && /^\d+$/.test(env)) return Number(env);
  return 3847;
}

export function resolveHost(): string {
  return process.env.SESSION_BRIDGE_HOST?.trim() || '127.0.0.1';
}

export function mcpUrl(host: string, port: number, path = '/mcp'): string {
  return `http://${host}:${port}${path}`;
}
