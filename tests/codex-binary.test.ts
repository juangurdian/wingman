import { describe, it, expect, beforeEach } from 'vitest';
import { resolveCodexBinary, _clearCodexBinaryCache } from '../src/codex-binary.js';

describe('resolveCodexBinary', () => {
  beforeEach(() => {
    _clearCodexBinaryCache();
  });

  it('prefers CODEX_BIN env override', () => {
    const result = resolveCodexBinary({ env: { CODEX_BIN: '/custom/codex' } });
    expect(result).toEqual({ bin: '/custom/codex', source: 'env' });
  });

  it('finds codex on PATH via where/which when CODEX_BIN is unset', () => {
    const spawnSync = (() => ({ status: 0, stdout: '/usr/bin/codex\n', stderr: '' })) as any;
    const result = resolveCodexBinary({ env: {}, platform: 'linux', spawnSync });
    expect(result.source).toBe('path');
    expect(result.bin).toBe('codex');
  });

  it('falls back to the Windows desktop app bundle via Get-AppxPackage', () => {
    const spawnSync = ((cmd: string) => {
      if (cmd === 'where') return { status: 1, stdout: '', stderr: '' };
      return {
        status: 0,
        stdout: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\',
        stderr: '',
      };
    }) as any;
    const existsSync = (() => true) as any;
    const result = resolveCodexBinary({ env: {}, platform: 'win32', spawnSync, existsSync });
    expect(result.source).toBe('desktop-app');
    expect(result.bin).toContain('app\\resources\\codex.exe');
  });

  it('does not probe a desktop app bundle outside win32/darwin', () => {
    const spawnSync = (() => ({ status: 1, stdout: '', stderr: '' })) as any;
    const existsSync = (() => true) as any;
    const result = resolveCodexBinary({ env: {}, platform: 'linux', spawnSync, existsSync });
    expect(result.source).toBe('not_found');
  });

  it('reports not_found when nothing resolves', () => {
    const spawnSync = (() => ({ status: 1, stdout: '', stderr: '' })) as any;
    const existsSync = (() => false) as any;
    const result = resolveCodexBinary({ env: {}, platform: 'win32', spawnSync, existsSync });
    expect(result).toEqual({ bin: 'codex', source: 'not_found' });
  });

  it('caches a result across calls until cleared', () => {
    let calls = 0;
    const spawnSync = (() => {
      calls++;
      return { status: 1, stdout: '', stderr: '' };
    }) as any;
    resolveCodexBinary({ env: {}, platform: 'linux', spawnSync });
    resolveCodexBinary({ env: {}, platform: 'linux', spawnSync });
    expect(calls).toBe(1);
    _clearCodexBinaryCache();
    resolveCodexBinary({ env: {}, platform: 'linux', spawnSync });
    expect(calls).toBe(2);
  });

  it('never throws when spawnSync itself throws', () => {
    const spawnSync = (() => {
      throw new Error('boom');
    }) as any;
    const existsSync = (() => false) as any;
    expect(() =>
      resolveCodexBinary({ env: {}, platform: 'win32', spawnSync, existsSync }),
    ).not.toThrow();
  });
});
