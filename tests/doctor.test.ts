import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/codex-binary.js', () => ({
  resolveCodexBinary: vi.fn(() => ({ bin: 'codex', source: 'not_found' })),
}));

describe('Doctor checks', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_MOCK', '1');
    vi.stubEnv('CODEX_MOCK', '1');
    vi.stubEnv('MUSE_MOCK', '1');
    vi.stubEnv('CLAUDE_DESKTOP_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('checkNodeVersion passes for Node 20+', async () => {
    const { checkNodeVersion } = await import('../src/doctor.js');
    const result = await checkNodeVersion();

    expect(result.name).toBe('Node.js version');
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    if (major >= 20) {
      expect(result.status).toBe('pass');
    } else {
      expect(result.status).toBe('fail');
    }
  });

  it('checkConfig returns warn when no config exists', async () => {
    const { checkConfig } = await import('../src/doctor.js');
    const result = await checkConfig();

    expect(result.name).toBe('Config file');
    expect(['pass', 'warn']).toContain(result.status);
  });

  it('checkPort returns pass when port is available', async () => {
    vi.stubEnv('WINGMAN_PORT', '59999');
    const { checkPort } = await import('../src/doctor.js');
    const result = await checkPort();

    expect(result.name).toBe('Port availability');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('59999');
  });

  it('checkClaudeSdk passes when CLAUDE_MOCK=1', async () => {
    const { checkClaudeSdk } = await import('../src/doctor.js');
    const result = await checkClaudeSdk();

    expect(result.name).toBe('Claude Agent SDK');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('CLAUDE_MOCK');
  });

  it('checkCodexBinary passes when CODEX_MOCK=1', async () => {
    const { checkCodexBinary } = await import('../src/doctor.js');
    const result = await checkCodexBinary();

    expect(result.name).toBe('Codex binary');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('CODEX_MOCK');
  });

  it('checkMuseBinary passes when MUSE_MOCK=1', async () => {
    const { checkMuseBinary } = await import('../src/doctor.js');
    const result = await checkMuseBinary();

    expect(result.name).toBe('Muse binary');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('MUSE_MOCK');
  });

  it('runAllChecks returns all check results', async () => {
    const { runAllChecks } = await import('../src/doctor.js');
    const results = await runAllChecks();

    expect(results.length).toBe(11);
    expect(results.map((r) => r.name)).toEqual([
      'Node.js version',
      'Config file',
      'Token security',
      'Heartbeat',
      'Port availability',
      'Claude Agent SDK',
      'Codex binary',
      'Muse binary',
      'Codex model config',
      'Host identity',
      'Claude desktop',
    ]);
  });

  it('check results have required fields', async () => {
    const { runAllChecks } = await import('../src/doctor.js');
    const results = await runAllChecks();

    for (const result of results) {
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    }
  });
});

describe('checkCodexBinary source reporting', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('names all three lookup strategies when nothing resolves', async () => {
    // Reset first so this test's mocks apply to the same fresh module
    // generation doctor.js resolves against, matching the pattern in the
    // "desktop app bundle" test below. Mocking spawn too (not relying on the
    // test machine lacking a real `codex` on PATH) keeps this deterministic
    // across machines and CI images.
    vi.resetModules();
    const { resolveCodexBinary } = (await import('../src/codex-binary.js')) as unknown as {
      resolveCodexBinary: ReturnType<typeof vi.fn>;
    };
    resolveCodexBinary.mockReturnValue({ bin: 'codex', source: 'not_found' });

    const fakeSpawn = vi.fn(() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      proc.stdout = new EventEmitter();
      const err = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      queueMicrotask(() => proc.emit('error', err));
      return proc;
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return { ...actual, spawn: fakeSpawn };
    });

    const { checkCodexBinary } = await import('../src/doctor.js');
    const result = await checkCodexBinary();

    expect(fakeSpawn).toHaveBeenCalled();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('CODEX_BIN');
    expect(result.message).toContain('PATH');
    expect(result.message).toContain('desktop app');
  });

  it('reports the desktop app bundle as the resolved source on success', async () => {
    // Reset first so this test's mockReturnValue and the child_process doMock
    // below apply to the SAME fresh module generation that doctor.js resolves
    // against (otherwise doctor.js could keep using instances cached by an
    // earlier test in this file).
    vi.resetModules();
    const { resolveCodexBinary } = (await import('../src/codex-binary.js')) as unknown as {
      resolveCodexBinary: ReturnType<typeof vi.fn>;
    };
    resolveCodexBinary.mockReturnValue({
      bin: 'C:\\...\\codex.exe',
      source: 'desktop-app',
      detail: 'C:\\...\\codex.exe',
    });

    // Guards against ever touching a real codex binary: `fakeSpawn` must be the
    // thing that actually runs, verified below. If stale module caching let a
    // real `spawn` through instead, `fakeSpawn` is never called and the
    // assertion on it fails loudly instead of silently running a real process.
    const fakeSpawn = vi.fn(() => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      proc.stdout = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from('codex-cli 0.169.0\n'));
        proc.emit('close', 0);
      });
      return proc;
    });
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return { ...actual, spawn: fakeSpawn };
    });

    const { checkCodexBinary } = await import('../src/doctor.js');
    const result = await checkCodexBinary();

    expect(fakeSpawn).toHaveBeenCalled();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('desktop app');
  });
});

describe('checkClaudeDesktop', () => {
  // Mocked at the module level (not via CLAUDE_DESKTOP_DATA_DIR/CLAUDE_DESKTOP_MOCK env)
  // so this test is deterministic regardless of whether this machine happens to have a
  // real Claude desktop install, and never reads real app data.
  afterEach(() => {
    vi.doUnmock('../src/claude-desktop.js');
    vi.resetModules();
  });

  it('reports no Claude desktop data dir found', async () => {
    vi.doMock('../src/claude-desktop.js', () => ({
      resolveClaudeDesktopDataDir: () => undefined,
      listClaudeDesktopSessions: () => [],
    }));
    vi.resetModules();
    const { checkClaudeDesktop } = await import('../src/doctor.js');
    const result = await checkClaudeDesktop();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('not found');
  });

  it('reports the session count when a data dir is found', async () => {
    vi.doMock('../src/claude-desktop.js', () => ({
      resolveClaudeDesktopDataDir: () => 'C:\\fake\\Claude-Data\\claude_test',
      listClaudeDesktopSessions: () => [
        { desktopId: 'local_a', cliSessionId: 'a' },
        { desktopId: 'local_b', cliSessionId: 'b' },
      ],
    }));
    vi.resetModules();
    const { checkClaudeDesktop } = await import('../src/doctor.js');
    const result = await checkClaudeDesktop();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('2');
  });
});
