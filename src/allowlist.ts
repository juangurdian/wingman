/**
 * Per-caller project path allowlist.
 *
 * One Wingman process shares a bearer token. The caller id selects which
 * roots that supervisor may see. This is a scope check, not a second auth factor:
 * a caller can claim any id the allowlist file defines.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, splitPathList } from './config.js';

export interface AllowlistFile {
  callers: Record<string, string[]>;
}

export interface AllowlistPolicy {
  caller: string;
  enforced: boolean;
  paths: string[];
}

export function allowlistPath(): string {
  return join(configDir(), 'allowlist.json');
}

export function loadAllowlistFile(path = allowlistPath()): AllowlistFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { callers?: Record<string, unknown> };
    const callers: Record<string, string[]> = {};
    for (const [id, value] of Object.entries(parsed.callers ?? {})) {
      if (!Array.isArray(value)) continue;
      callers[id] = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }
    return { callers };
  } catch {
    return { callers: {} };
  }
}

export function resolveCallerPaths(input: {
  caller: string;
  file?: AllowlistFile | null;
  envPaths?: string[];
}): { enforced: boolean; paths: string[] } {
  const fromFile = input.file?.callers?.[input.caller];
  if (fromFile) return { enforced: true, paths: fromFile };
  if (input.envPaths && input.envPaths.length > 0) return { enforced: true, paths: input.envPaths };
  const fileHasCallers = Boolean(input.file && Object.keys(input.file.callers).length > 0);
  if (fileHasCallers) return { enforced: true, paths: [] };
  return { enforced: false, paths: [] };
}

export function resolveAllowlist(opts?: {
  caller?: string;
  env?: NodeJS.ProcessEnv;
  file?: AllowlistFile | null;
}): AllowlistPolicy {
  const env = opts?.env ?? process.env;
  const caller = (opts?.caller ?? env.WINGMAN_CALLER ?? 'default').trim() || 'default';
  const file = opts?.file === undefined ? loadAllowlistFile() : opts.file;
  const envPaths = splitPathList(env.WINGMAN_ALLOWED_PATHS);
  const resolved = resolveCallerPaths({ caller, file, envPaths });
  return { caller, ...resolved };
}

function looksWindows(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}

/** Lexical normalize. Does not touch the filesystem, so Windows paths stay intact on Linux tests. */
export function lexicalPath(p: string, win: boolean): string {
  let s = p.trim().replace(/\\/g, '/');
  const drive = win ? /^([A-Za-z]:)(.*)$/.exec(s) : null;
  let prefix = '';
  let rest = s;
  if (drive) {
    prefix = drive[1]!.toUpperCase();
    rest = drive[2] || '/';
  } else if (win && s.startsWith('//')) {
    prefix = '//';
    rest = s.slice(2);
  }
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(win ? part.toLowerCase() : part);
  }
  if (drive) return `${prefix}/${parts.join('/')}`;
  if (prefix === '//') return `//${parts.join('/')}`;
  return `${s.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

export function isPathInside(root: string, target: string): boolean {
  const win = looksWindows(root) || looksWindows(target) || process.platform === 'win32';
  const r = lexicalPath(root, win);
  const t = lexicalPath(target, win);
  if (!r || !t) return false;
  if (t === r) return true;
  const prefix = r.endsWith('/') ? r : `${r}/`;
  return t.startsWith(prefix);
}

export function isPathAllowed(target: string | undefined, roots: string[]): boolean {
  if (!target?.trim()) return false;
  return roots.some((root) => root.trim().length > 0 && isPathInside(root, target));
}
