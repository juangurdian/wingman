import { spawnSync } from 'node:child_process';

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: string[]) => GitRunResult;

export interface GitSnapshot {
  head?: string;
  dirtyFiles: string[];
  error?: string;
}

/** `git status --porcelain` lines. Rename entries keep the destination path. */
export function parsePorcelain(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const body = line.length >= 3 ? line.slice(3) : line;
    const arrow = body.lastIndexOf(' -> ');
    files.push((arrow >= 0 ? body.slice(arrow + 4) : body).trim());
  }
  return files;
}

export function readGitSnapshot(cwd: string, run: GitRunner = defaultGitRunner): GitSnapshot {
  const head = run(cwd, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return {
      dirtyFiles: [],
      error: (head.stderr || 'not a git repository').trim(),
    };
  }
  const status = run(cwd, ['status', '--porcelain']);
  if (!status.ok) {
    return {
      head: head.stdout.trim(),
      dirtyFiles: [],
      error: (status.stderr || 'git status failed').trim(),
    };
  }
  return { head: head.stdout.trim(), dirtyFiles: parsePorcelain(status.stdout) };
}

export const defaultGitRunner: GitRunner = (cwd, args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? result.error.message : ''}`.trim(),
  };
};
