import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveClaudeDesktopDataDir,
  listClaudeDesktopSessions,
  isClaudeDesktopAppRunning,
  isClaudeDesktopTurnRunningFor,
  setMockClaudeDesktopSessions,
  setMockClaudeDesktopAppState,
} from '../src/claude-desktop.js';

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setMockClaudeDesktopSessions(null);
  setMockClaudeDesktopAppState(null);
  delete process.env.CLAUDE_DESKTOP_MOCK;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveClaudeDesktopDataDir', () => {
  it('returns the env override verbatim', () => {
    const dir = resolveClaudeDesktopDataDir({ env: { CLAUDE_DESKTOP_DATA_DIR: '/custom/dir' } });
    expect(dir).toBe('/custom/dir');
  });

  it('picks the most recently modified claude_* dir under Claude-Data on Windows', () => {
    const base = makeTmpDir('claude-data-root');
    const claudeDataDir = join(base, 'Claude-Data');
    const oldDir = join(claudeDataDir, 'claude_old');
    const newDir = join(claudeDataDir, 'claude_new');
    mkdirSync(oldDir, { recursive: true });
    // Ensure a measurable mtime difference.
    mkdirSync(newDir, { recursive: true });
    const now = Date.now();
    utimesSync(oldDir, now / 1000 - 100, now / 1000 - 100);
    utimesSync(newDir, now / 1000, now / 1000);

    const dir = resolveClaudeDesktopDataDir({
      env: { LOCALAPPDATA: base },
      platform: 'win32',
    });
    expect(dir).toBe(newDir);
  });

  it('returns undefined when no candidate directory exists', () => {
    const base = makeTmpDir('no-claude-data');
    const dir = resolveClaudeDesktopDataDir({
      env: { LOCALAPPDATA: base, APPDATA: join(base, 'does-not-exist') },
      platform: 'win32',
    });
    expect(dir).toBeUndefined();
  });
});

describe('listClaudeDesktopSessions (real mode)', () => {
  it('projects only the documented fields and drops snapshot/config fields', () => {
    const dataDir = makeTmpDir('claude-desktop-data');
    const sessDir = join(dataDir, 'claude-code-sessions', 'acct1', 'org1');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, 'local_abc.json'),
      JSON.stringify({
        sessionId: 'local_abc',
        cliSessionId: 'cli-123',
        title: 'My session',
        cwd: 'C:\\proj',
        isArchived: false,
        lastActivityAt: 123,
        promptAppendSnapshot: 'SECRET SNAPSHOT',
        toolSurfaceSnapshot: { tools: ['bash'] },
        remoteMcpServersConfig: { token: 'should-never-appear' },
        enabledMcpTools: ['x'],
      }),
    );

    const sessions = listClaudeDesktopSessions({ dataDir });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cliSessionId).toBe('cli-123');
    expect(sessions[0].desktopId).toBe('local_abc');
    expect(sessions[0].title).toBe('My session');
    expect(JSON.stringify(sessions[0])).not.toContain('SECRET SNAPSHOT');
    expect(sessions[0]).not.toHaveProperty('promptAppendSnapshot');
    expect(sessions[0]).not.toHaveProperty('toolSurfaceSnapshot');
    expect(sessions[0]).not.toHaveProperty('remoteMcpServersConfig');
    expect(sessions[0]).not.toHaveProperty('enabledMcpTools');
  });

  it('excludes archived sessions by default and includes them when asked', () => {
    const dataDir = makeTmpDir('claude-desktop-archived');
    const sessDir = join(dataDir, 'claude-code-sessions', 'acct1', 'org1');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, 'local_old.json'),
      JSON.stringify({ sessionId: 'local_old', cliSessionId: 'cli-old', isArchived: true }),
    );

    expect(listClaudeDesktopSessions({ dataDir })).toHaveLength(0);
    expect(listClaudeDesktopSessions({ dataDir, includeArchived: true })).toHaveLength(1);
  });

  it('skips a malformed session file without throwing', () => {
    const dataDir = makeTmpDir('claude-desktop-malformed');
    const sessDir = join(dataDir, 'claude-code-sessions', 'acct1', 'org1');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'local_bad.json'), '{ this is not json');
    writeFileSync(
      join(sessDir, 'local_good.json'),
      JSON.stringify({ sessionId: 'local_good', cliSessionId: 'cli-good' }),
    );

    expect(() => listClaudeDesktopSessions({ dataDir })).not.toThrow();
    const sessions = listClaudeDesktopSessions({ dataDir });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cliSessionId).toBe('cli-good');
  });

  it('returns an empty list when the data dir does not exist', () => {
    expect(listClaudeDesktopSessions({ dataDir: join(tmpdir(), 'definitely-missing-dir-xyz') })).toEqual([]);
  });
});

describe('listClaudeDesktopSessions (mock mode)', () => {
  it('returns the injected mock sessions', () => {
    process.env.CLAUDE_DESKTOP_MOCK = '1';
    setMockClaudeDesktopSessions([{ desktopId: 'local_x', cliSessionId: 'cli-x' }]);
    expect(listClaudeDesktopSessions()).toHaveLength(1);
  });
});

describe('Claude desktop app-open / busy detection', () => {
  it('short-circuits to false on non-Windows without shelling out', () => {
    expect(isClaudeDesktopAppRunning({ platform: 'darwin' })).toBe(false);
    expect(isClaudeDesktopTurnRunningFor('cli-123', { platform: 'linux' })).toBe(false);
  });

  it('mock mode reports app-open and per-session busy state', () => {
    process.env.CLAUDE_DESKTOP_MOCK = '1';
    setMockClaudeDesktopAppState({ appOpen: true, busySessionIds: ['cli-123'] });
    expect(isClaudeDesktopAppRunning()).toBe(true);
    expect(isClaudeDesktopTurnRunningFor('cli-123')).toBe(true);
    expect(isClaudeDesktopTurnRunningFor('cli-999')).toBe(false);
  });

  it('mock mode defaults to not open / not busy when no state is injected', () => {
    process.env.CLAUDE_DESKTOP_MOCK = '1';
    expect(isClaudeDesktopAppRunning()).toBe(false);
    expect(isClaudeDesktopTurnRunningFor('cli-123')).toBe(false);
  });
});

// Sanity check that our mtime helper actually works on this filesystem.
describe('test helper sanity', () => {
  it('makeTmpDir creates a real, statable directory', () => {
    const dir = makeTmpDir('sanity');
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
