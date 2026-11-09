import { readFileSync } from 'node:fs';

/** Parse Linux `/proc/<pid>/status` VmRSS into bytes. */
export function parseProcStatusRss(text: string): number | undefined {
  const match = text.match(/^VmRSS:\s+(\d+)\s+kB/m);
  if (!match) return undefined;
  return Number(match[1]) * 1024;
}

/**
 * RSS in bytes. The current process always uses `process.memoryUsage()`.
 * Other pids are read from `/proc` on Linux. Windows has no `/proc`, so other
 * pids return undefined and the caller says so.
 */
export function readRssBytes(pid: number): number | undefined {
  if (pid === process.pid) return process.memoryUsage().rss;
  try {
    return parseProcStatusRss(readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return undefined;
  }
}
