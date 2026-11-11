/**
 * Child processes are spawned with shell:false.
 *
 * Node DEP0190 fires when arguments are passed together with shell:true, because
 * the shell concatenates them without quoting. On Windows a tool is often a
 * .cmd shim. Resolve that path and spawn it directly.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SpawnPlan {
  command: string;
  args: string[];
  shell: false;
}

export function commandSpawnPlan(command: string, args: string[]): SpawnPlan {
  return { command, args, shell: false };
}

function extensions(pathExt: string): string[] {
  return pathExt
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
}

/**
 * On Windows, return the first PATH match that already has an executable extension.
 * Other platforms return `bin` unchanged.
 */
export function resolveCommandOnPath(
  bin: string,
  opts?: {
    platform?: NodeJS.Platform;
    pathEnv?: string;
    pathExt?: string;
    exists?: (path: string) => boolean;
  },
): string {
  const platform = opts?.platform ?? process.platform;
  if (platform !== 'win32') return bin;
  const exists = opts?.exists ?? existsSync;
  const pathExt = opts?.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = extensions(pathExt);

  const withExtension = (file: string): string | undefined => {
    if (exists(file)) return file;
    if (/\.(exe|cmd|bat|com)$/i.test(file)) return undefined;
    for (const ext of exts) {
      const candidate = file + ext;
      if (exists(candidate)) return candidate;
    }
    return undefined;
  };

  if (bin.includes('\\') || bin.includes('/')) {
    return withExtension(bin) ?? bin;
  }

  const pathEnv = opts?.pathEnv ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(';').filter(Boolean)) {
    const found = withExtension(join(dir, bin));
    if (found) return found;
  }
  return bin;
}
