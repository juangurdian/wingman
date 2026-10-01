/**
 * Real-mode Claude provider tests with the Agent SDK replaced by a fake.
 * Covers what mock mode cannot: the options Wingman passes to query(), the
 * canUseTool approval bridge, failed results, and interrupt aborting the SDK.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type QueryOptions = Record<string, unknown> & {
  abortController: AbortController;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[] },
  ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }>;
};

const sdk = vi.hoisted(() => ({
  calls: [] as { prompt: string; options: QueryOptions }[],
  script: (async function* () {}) as (options: QueryOptions) => AsyncGenerator<unknown>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: string; options: QueryOptions }) => {
    sdk.calls.push({ prompt, options });
    return sdk.script(options);
  },
  getSessionMessages: async () => [
    { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'All done' }] } },
  ],
  getSessionInfo: async () => null,
  listSessions: async () => [],
}));

const success = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };

describe('ClaudeProvider real mode (fake SDK)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wingman-claude-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_MOCK', '');
    vi.stubEnv('CLAUDE_DISCOVER', '0');
    sdk.calls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function provider() {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    return new ClaudeProvider();
  }

  it('runs turns without a turn cap and with an approval callback', async () => {
    sdk.script = async function* () {
      yield success;
    };
    const claude = await provider();
    const created = await claude.createSession({ cwd: home, prompt: 'Build a scraper' });
    await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });

    const { options } = sdk.calls[0]!;
    expect(options.maxTurns).toBeUndefined();
    expect(options.permissionMode).toBe('default');
    expect(typeof options.canUseTool).toBe('function');
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.sessionId).toBe(created.sessionId);
  });

  it('passes CLAUDE_PERMISSION_MODE and CLAUDE_MAX_TURNS through', async () => {
    vi.stubEnv('CLAUDE_PERMISSION_MODE', 'acceptEdits');
    vi.stubEnv('CLAUDE_MAX_TURNS', '25');
    sdk.script = async function* () {
      yield success;
    };
    const claude = await provider();
    const created = await claude.createSession({ cwd: home });
    await claude.sendMessage(created.sessionId, 'hello');
    await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });

    const { options } = sdk.calls[0]!;
    expect(options.permissionMode).toBe('acceptEdits');
    expect(options.maxTurns).toBe(25);
    expect(options.resume).toBe(created.sessionId);
  });

  it('bridges permission prompts to list_approvals / resolve_approval', async () => {
    let decision: unknown;
    sdk.script = async function* (options) {
      decision = await options.canUseTool(
        'Bash',
        { command: 'npm test' },
        { signal: options.abortController.signal, suggestions: [] },
      );
      yield success;
    };
    const claude = await provider();
    const created = await claude.createSession({ cwd: home, prompt: 'Run the tests' });

    const blocked = await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(blocked).toMatchObject({ status: 'inProgress', pendingApprovals: 1 });

    const [approval] = (await claude.listApprovals(created.sessionId)).approvals;
    expect(approval).toMatchObject({ kind: 'command', toolName: 'Bash', command: 'npm test', cwd: home });

    await claude.resolveApproval(created.sessionId, approval!.id, 'accept');
    const done = await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });

    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(done).toMatchObject({ status: 'completed', latestMessage: 'All done' });
  });

  it('pins acceptForSession rules to the session', async () => {
    let decision: { updatedPermissions?: { destination: string }[] } | undefined;
    sdk.script = async function* (options) {
      decision = (await options.canUseTool('Edit', { file_path: 'a.ts' }, {
        signal: options.abortController.signal,
        suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' },
        ],
      })) as typeof decision;
      yield success;
    };
    const claude = await provider();
    const created = await claude.createSession({ cwd: home, prompt: 'Edit a file' });
    await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });

    const [approval] = (await claude.listApprovals(created.sessionId)).approvals;
    expect(approval?.kind).toBe('fileChange');
    await claude.resolveApproval(created.sessionId, approval!.id, 'acceptForSession');
    await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });

    expect(decision?.updatedPermissions?.[0]?.destination).toBe('session');
  });

  it('reports failed turns with the SDK error', async () => {
    sdk.script = async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API overloaded'] };
    };
    const claude = await provider();
    const created = await claude.createSession({ cwd: home, prompt: 'Do work' });

    const waited = await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(waited).toMatchObject({ status: 'failed', error: 'API overloaded' });

    const detail = await claude.getSession(created.sessionId);
    expect(detail?.lastError).toBe('API overloaded');
  });

  it('interrupt aborts the running SDK query and denies pending approvals', async () => {
    let decision: { behavior: string } | undefined;
    sdk.script = async function* (options) {
      decision = await options.canUseTool('Bash', { command: 'sleep 100' }, {
        signal: options.abortController.signal,
      });
      await new Promise((resolve) =>
        options.abortController.signal.aborted
          ? resolve(undefined)
          : options.abortController.signal.addEventListener('abort', resolve),
      );
      throw new Error('aborted');
    };
    const claude = await provider();
    const created = await claude.createSession({ cwd: home, prompt: 'Long task' });
    await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });

    const result = await claude.interrupt(created.sessionId);
    expect(result.status).toBe('interrupted');
    expect(sdk.calls[0]!.options.abortController.signal.aborted).toBe(true);

    const waited = await claude.waitTurn(created.sessionId, { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(waited.status).toBe('interrupted');
    expect(decision?.behavior).toBe('deny');
    expect((await claude.listApprovals(created.sessionId)).approvals).toEqual([]);
  });
});
