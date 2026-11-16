/**
 * Child processes are spawned with shell:false.
 *
 * Node DEP0190 fires when arguments are passed together with shell:true, because
 * the shell concatenates them without quoting. A Windows .exe is spawned
 * directly. A .cmd or .bat file cannot run that way, so it goes through
 * cmd.exe /d /s /c with the command line quoted and shell left false.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SpawnPlan {
  command: string;
  args: string[];
  shell: false;
  /** Set when the command line is already quoted for cmd.exe. */
  windowsVerbatimArguments?: boolean;
}

/**
 * Quote one argv element for `cmd.exe /d /s /c`.
 * The result is safe to place inside the outer quotes that `/s` strips.
 */
export function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += `${'\\'.repeat(slashes * 2 + 1)}"`;
      slashes = 0;
      continue;
    }
    if (slashes > 0) {
      out += '\\'.repeat(slashes);
      slashes = 0;
    }
    out += ch;
  }
  if (slashes > 0) out += '\\'.repeat(slashes * 2);
  return `${out}"`;
}

/** One `/c` argument. The outer quotes are the pair that `cmd.exe /s` strips. */
export function quoteCmdCommandLine(parts: string[]): string {
  return `"${parts.map(quoteCmdArg).join(' ')}"`;
}

export function commandSpawnPlan(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec?.trim() || 'cmd.exe',
      args: ['/d', '/s', '/c', quoteCmdCommandLine([command, ...args])],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
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
