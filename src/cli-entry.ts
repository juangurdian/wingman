/**
 * True when this process is the named CLI, including an npm bin symlink.
 * Direct `node dist/pair.js` and a Unix symlink named `wingman-pair` both match.
 * Importing the module from a test does not.
 */

import { realpathSync } from 'node:fs';
import { basename } from 'node:path';

export function isCliMain(
  argv1: string | undefined,
  names: string[],
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;
  const paths = [argv1];
  try {
    const resolved = realpath(argv1);
    if (resolved && resolved !== argv1) paths.push(resolved);
  } catch {
    /* argv is not a file, which is normal under a test runner */
  }
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  return paths.some((path) => {
    const base = basename(path).toLowerCase();
    if (accepted.has(base)) return true;
    for (const name of accepted) {
      if (base === `${name}.js` || base === `${name}.ts` || base === `${name}.mjs` || base === `${name}.cmd`) {
        return true;
      }
    }
    return false;
  });
}
