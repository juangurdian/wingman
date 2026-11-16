/**
 * Resolve which `codex` binary to spawn.
 *
 * Order:
 * 1. CODEX_BIN env var (trusted as-is, no existence check).
 * 2. `codex` on PATH, probed with `where codex` (Windows) / `which codex` (else).
 * 3. The Codex desktop app's bundled CLI:
 *    - Windows (MSIX): `Get-AppxPackage OpenAI.Codex` InstallLocation, then
 *      `<InstallLocation>\app\resources\codex.exe`.
 *    - macOS (unverified candidate): `/Applications/Codex.app/Contents/Resources/codex`.
 * 4. Not found. Callers keep using `codex` as the command so the existing
 *    ENOENT handling still applies.
 *
 * The result is cached briefly (module-level, 60s TTL) so a long-lived
 * Wingman process does not re-probe PATH/PowerShell on every call. Tests
 * should call `_clearCodexBinaryCache()` between cases.
 */

import { existsSync as nodeExistsSync } from 'node:fs';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { join } from 'node:path';

export type CodexBinarySource = 'env' | 'path' | 'desktop-app' | 'not_found';

export interface CodexBinaryResolution {
  bin: string;
  source: CodexBinarySource;
  detail?: string;
}

export interface ResolveCodexBinaryDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  spawnSync?: typeof nodeSpawnSync;
}

const CACHE_TTL_MS = 60_000;

let cached: { result: CodexBinaryResolution; expiresAt: number } | null = null;

/** Test-only: forget the cached resolution so the next call re-probes. */
export function _clearCodexBinaryCache(): void {
  cached = null;
}

function tryPathLookup(
  platform: NodeJS.Platform,
  spawnSync: typeof nodeSpawnSync,
): CodexBinaryResolution | undefined {
  try {
    const lookupCmd = platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookupCmd, ['codex'], { encoding: 'utf8', timeout: 5000 });
    if (result?.status === 0) {
      const firstLine = (result.stdout ?? '').split(/\r?\n/).find((line) => line.trim());
      if (firstLine?.trim()) {
        return { bin: 'codex', source: 'path', detail: firstLine.trim() };
      }
    }
  } catch {
    /* PATH lookup unavailable; fall through */
  }
  return undefined;
}

function tryDesktopAppWindows(
  spawnSync: typeof nodeSpawnSync,
  existsSync: (path: string) => boolean,
): CodexBinaryResolution | undefined {
  try {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-AppxPackage OpenAI.Codex).InstallLocation',
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    const installLocation = result?.status === 0 ? (result.stdout ?? '').trim() : '';
    if (!installLocation) return undefined;
    const candidate = join(installLocation, 'app', 'resources', 'codex.exe');
    if (existsSync(candidate)) {
      return { bin: candidate, source: 'desktop-app', detail: candidate };
    }
  } catch {
    /* desktop app lookup unavailable; fall through */
  }
  return undefined;
}

function tryDesktopAppMac(existsSync: (path: string) => boolean): CodexBinaryResolution | undefined {
  const candidate = '/Applications/Codex.app/Contents/Resources/codex';
  try {
    if (existsSync(candidate)) {
      return { bin: candidate, source: 'desktop-app', detail: `${candidate} (unverified candidate path)` };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function resolveFresh(deps: ResolveCodexBinaryDeps): CodexBinaryResolution {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;

  const envBin = env.CODEX_BIN?.trim();
  if (envBin) {
    return { bin: envBin, source: 'env' };
  }

  const viaPath = tryPathLookup(platform, spawnSync);
  if (viaPath) return viaPath;

  if (platform === 'win32') {
    const viaDesktop = tryDesktopAppWindows(spawnSync, existsSync);
    if (viaDesktop) return viaDesktop;
  } else if (platform === 'darwin') {
    const viaDesktop = tryDesktopAppMac(existsSync);
    if (viaDesktop) return viaDesktop;
  }

  return { bin: 'codex', source: 'not_found' };
}

/**
 * Resolve the Codex binary. Cached for 60s when called with no args (or the
 * same args shape); pass `deps` in tests to get deterministic, uncached
 * results, and call `_clearCodexBinaryCache()` between cases.
 */
export function resolveCodexBinary(deps: ResolveCodexBinaryDeps = {}): CodexBinaryResolution {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }
  let result: CodexBinaryResolution;
  try {
    result = resolveFresh(deps);
  } catch {
    result = { bin: 'codex', source: 'not_found' };
  }
  cached = { result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
