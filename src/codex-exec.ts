/**
 * Argv for `codex exec` on CLI 0.166.
 * `--full-auto` was removed. Do not emit it.
 * The prompt is not an argument: it is written to stdin (`-`), which keeps
 * multi-line text intact on Windows without going through PowerShell.
 */

export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

export interface CodexExecPlan {
  args: string[];
  /** Always true. Spawn with shell: false and write the prompt to stdin. */
  promptOnStdin: true;
  shell: false;
}

export function parseCodexSandbox(value: string | undefined): CodexSandbox {
  if (value == null || value.trim() === '') return 'read-only';
  const sandbox = value.trim();
  if (sandbox === 'full-auto' || sandbox === '--full-auto') {
    throw new Error(
      '--full-auto was removed in Codex CLI 0.166. Pass sandbox "workspace-write" or "read-only".',
    );
  }
  if (!(CODEX_SANDBOXES as readonly string[]).includes(sandbox)) {
    throw new Error(
      `Unknown sandbox "${sandbox}". Use read-only, workspace-write, or danger-full-access.`,
    );
  }
  return sandbox as CodexSandbox;
}

export function buildCodexExecArgs(input: {
  cwd?: string;
  sandbox?: string;
  model?: string;
  resumeSessionId?: string;
  skipGitRepoCheck?: boolean;
}): CodexExecPlan {
  const sandbox = parseCodexSandbox(input.sandbox);
  const args = ['exec'];
  if (input.resumeSessionId) args.push('resume');
  if (input.cwd) args.push('--cd', input.cwd);
  args.push('--sandbox', sandbox);
  if (input.model?.trim()) args.push('--model', input.model.trim());
  args.push('--json', '--color', 'never');
  if (input.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (input.resumeSessionId) args.push(input.resumeSessionId);
  args.push('-');
  if (args.includes('--full-auto')) {
    throw new Error('refusing to pass --full-auto');
  }
  return { args, promptOnStdin: true, shell: false };
}
