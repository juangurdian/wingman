import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Doctor checks', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_MOCK', '1');
    vi.stubEnv('CODEX_MOCK', '1');
    vi.stubEnv('MUSE_MOCK', '1');
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

    expect(results.length).toBe(8);
    expect(results.map((r) => r.name)).toEqual([
      'Node.js version',
      'Config file',
      'Port availability',
      'Claude Agent SDK',
      'Codex binary',
      'Muse binary',
      'Codex model config',
      'Host identity',
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
