/**
 * Claude desktop app (Code tab) session discovery.
 *
 * The Claude desktop app indexes its own Code-tab sessions at
 * `<dataDir>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<uuid>.json`.
 * These files also carry large snapshot/config fields
 * (promptAppendSnapshot, toolSurfaceSnapshot, remoteMcpServersConfig,
 * enabledMcpTools) that may hold prompt or MCP server configuration. This
 * module never reads those fields into any returned value: parsing uses an
 * explicit allowlist, never a spread of the raw file contents.
 *
 * Data dir resolution order:
 * 1. CLAUDE_DESKTOP_DATA_DIR env var (trusted as-is).
 * 2. Windows MSIX: the most recently modified `claude_*` dir under
 *    `%LOCALAPPDATA%\Claude-Data`.
 * 3. Windows non-MSIX (unverified candidate): `%APPDATA%\Claude`.
 * 4. macOS (unverified candidate): `~/Library/Application Support/Claude`.
 * 5. Linux (unverified candidate): `~/.config/Claude`.
 * No candidate found: discovery returns an empty list, not an error.
 *
 * App-open / per-session-busy detection is Windows-only for now (PowerShell
 * process enumeration, read-only, short-TTL cached). Other platforms report
 * false rather than guessing.
 *
 * Mock mode: CLAUDE_DESKTOP_MOCK=1, with setMockClaudeDesktopSessions /
 * setMockClaudeDesktopAppState test hooks, mirrors the pattern used by
 * claude-inbox.ts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ClaudeDesktopSession {
  desktopId: string;
  cliSessionId?: string;
  cwd?: string;
  originCwd?: string;
  worktreePath?: string;
  title?: string;
  isArchived?: boolean;
  lastFocusedAt?: number;
  lastActivityAt?: number;
  lastTurnEdgeAt?: number;
  model?: string;
  effort?: string;
  permissionMode?: string;
  completedTurns?: number;
  remoteControlAutoEligible?: boolean;
}

export interface ResolveClaudeDesktopDataDirDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ClaudeDesktopPlatformDeps {
  platform?: NodeJS.Platform;
}

function useMock(): boolean {
  return process.env.CLAUDE_DESKTOP_MOCK === '1' || process.env.CLAUDE_DESKTOP_MOCK === 'true';
}

function mostRecentlyModifiedSubdir(parent: string, prefix: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(parent).filter((name) => name.startsWith(prefix));
  } catch {
    return undefined;
  }
  let best: { path: string; mtimeMs: number } | undefined;
  for (const name of entries) {
    const full = join(parent, name);
    try {
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { path: full, mtimeMs: stat.mtimeMs };
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return best?.path;
}

/** Resolve the Claude desktop app's data directory, or undefined when none is found. */
export function resolveClaudeDesktopDataDir(deps: ResolveClaudeDesktopDataDirDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;

  const override = env.CLAUDE_DESKTOP_DATA_DIR?.trim();
  if (override) return override;

  try {
    if (platform === 'win32') {
      const localAppData = env.LOCALAPPDATA?.trim();
      if (localAppData) {
        const claudeDataDir = join(localAppData, 'Claude-Data');
        const match = mostRecentlyModifiedSubdir(claudeDataDir, 'claude_');
        if (match) return match;
      }
      const appData = env.APPDATA?.trim();
      if (appData) {
        const candidate = join(appData, 'Claude');
        if (existsSync(candidate)) return candidate;
      }
      return undefined;
    }
    if (platform === 'darwin') {
      const candidate = join(homedir(), 'Library', 'Application Support', 'Claude');
      return existsSync(candidate) ? candidate : undefined;
    }
    const candidate = join(homedir(), '.config', 'Claude');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Build a ClaudeDesktopSession from a parsed session file, using an explicit field allowlist. */
function projectDesktopSessionFile(raw: unknown, desktopId: string): ClaudeDesktopSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  return {
    desktopId,
    cliSessionId: str(r.cliSessionId),
    cwd: str(r.cwd),
    originCwd: str(r.originCwd),
    worktreePath: str(r.worktreePath),
    title: str(r.title),
    isArchived: bool(r.isArchived),
    lastFocusedAt: num(r.lastFocusedAt),
    lastActivityAt: num(r.lastActivityAt),
    lastTurnEdgeAt: num(r.lastTurnEdgeAt),
    model: str(r.model),
    effort: str(r.effort),
    permissionMode: str(r.permissionMode),
    completedTurns: num(r.completedTurns),
    remoteControlAutoEligible: bool(r.remoteControlAutoEligible),
  };
}

function readDesktopSessionFiles(dataDir: string): ClaudeDesktopSession[] {
  const sessions: ClaudeDesktopSession[] = [];
  const sessionsRoot = join(dataDir, 'claude-code-sessions');
  let accountDirs: string[];
  try {
    accountDirs = readdirSync(sessionsRoot);
  } catch {
    return sessions;
  }
  for (const accountDir of accountDirs) {
    const accountPath = join(sessionsRoot, accountDir);
    let orgDirs: string[];
    try {
      if (!statSync(accountPath).isDirectory()) continue;
      orgDirs = readdirSync(accountPath);
    } catch {
      continue;
    }
    for (const orgDir of orgDirs) {
      const orgPath = join(accountPath, orgDir);
      let files: string[];
      try {
        if (!statSync(orgPath).isDirectory()) continue;
        files = readdirSync(orgPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^local_[^./\\]+\.json$/.test(file)) continue;
        const desktopId = file.slice(0, -'.json'.length);
        try {
          const content = readFileSync(join(orgPath, file), 'utf8');
          const parsed = JSON.parse(content) as unknown;
          const session = projectDesktopSessionFile(parsed, desktopId);
          if (session) sessions.push(session);
        } catch {
          /* malformed or unreadable file; skip it */
        }
      }
    }
  }
  return sessions;
}

let mockSessions: ClaudeDesktopSession[] | null = null;

/** Test-only: inject the list returned by listClaudeDesktopSessions() under CLAUDE_DESKTOP_MOCK. */
export function setMockClaudeDesktopSessions(sessions: ClaudeDesktopSession[] | null): void {
  mockSessions = sessions;
}

export function listClaudeDesktopSessions(opts?: { includeArchived?: boolean; dataDir?: string }): ClaudeDesktopSession[] {
  const includeArchived = opts?.includeArchived ?? false;
  if (useMock()) {
    const sessions = mockSessions ?? [];
    return includeArchived ? sessions : sessions.filter((s) => s.isArchived !== true);
  }
  const dataDir = opts?.dataDir ?? resolveClaudeDesktopDataDir();
  if (!dataDir) return [];
  const sessions = readDesktopSessionFiles(dataDir);
  return includeArchived ? sessions : sessions.filter((s) => s.isArchived !== true);
}

interface ClaudeExeProcess {
  executablePath: string;
  commandLine: string;
}

const PROCESS_CACHE_TTL_MS = 5000;
let processCache: { rows: ClaudeExeProcess[]; expiresAt: number } | null = null;

function queryClaudeExeProcesses(): ClaudeExeProcess[] {
  if (processCache && Date.now() < processCache.expiresAt) return processCache.rows;
  let rows: ClaudeExeProcess[] = [];
  try {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
          'Select-Object ExecutablePath,CommandLine | ConvertTo-Json',
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (result.status === 0 && result.stdout?.trim()) {
      const parsed = JSON.parse(result.stdout) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      rows = list
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          executablePath: typeof item.ExecutablePath === 'string' ? item.ExecutablePath : '',
          commandLine: typeof item.CommandLine === 'string' ? item.CommandLine : '',
        }));
    }
  } catch {
    rows = [];
  }
  processCache = { rows, expiresAt: Date.now() + PROCESS_CACHE_TTL_MS };
  return rows;
}

let mockAppState: { appOpen?: boolean; busySessionIds?: string[] } | null = null;

/** Test-only: inject the state returned by isClaudeDesktopAppRunning/isClaudeDesktopTurnRunningFor under CLAUDE_DESKTOP_MOCK. */
export function setMockClaudeDesktopAppState(state: { appOpen?: boolean; busySessionIds?: string[] } | null): void {
  mockAppState = state;
}

export function isClaudeDesktopAppRunning(deps: ClaudeDesktopPlatformDeps = {}): boolean {
  if (useMock()) return mockAppState?.appOpen ?? false;
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return false;
  try {
    return queryClaudeExeProcesses().some(
      (p) => /\\WindowsApps\\Claude_/i.test(p.executablePath) && !/--type=/i.test(p.commandLine),
    );
  } catch {
    return false;
  }
}

export function isClaudeDesktopTurnRunningFor(cliSessionId: string, deps: ClaudeDesktopPlatformDeps = {}): boolean {
  if (useMock()) return mockAppState?.busySessionIds?.includes(cliSessionId) ?? false;
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return false;
  try {
    return queryClaudeExeProcesses().some(
      (p) => /\\claude-code\\/i.test(p.executablePath) && p.commandLine.includes(cliSessionId),
    );
  } catch {
    return false;
  }
}
