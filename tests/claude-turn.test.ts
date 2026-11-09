import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildClaudeQueryOptions,
  claudeTurnNote,
  extractModelFromSessionMessages,
  ClaudePromptStream,
} from '../src/providers/claude-turn.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildClaudeQueryOptions', () => {
  it('resumes the same id with a high turn budget and a host permission prompt', () => {
    const plan = buildClaudeQueryOptions({
      binding: 'resume',
      sessionId: 'sess-1',
      cwd: '/work',
    });

    expect(plan.resumeMode).toBe('resume');
    expect(plan.forkSession).toBe(false);
    expect(plan.maxTurns).toBe(50);
    expect(plan.permissionMode).toBe('default');
    expect(plan.model).toBeUndefined();
    expect(plan.modelSource).toBe('cli-default');
    expect(plan.options).toMatchObject({
      cwd: '/work',
      resume: 'sess-1',
      forkSession: false,
      maxTurns: 50,
      permissionMode: 'default',
      permissionPrompts: 'host',
    });
    expect(plan.options.sessionId).toBeUndefined();
    expect(plan.options.model).toBeUndefined();
    expect(JSON.stringify(plan)).not.toMatch(/sonnet|opus|haiku|gpt-/i);
    expect(plan.note).toBe(claudeTurnNote('resume'));
    expect(plan.note).not.toContain('\u2014');
  });

  it('inherits the session model ahead of the CLI default, and prefers call then env', () => {
    const inherited = buildClaudeQueryOptions({
      binding: 'resume',
      sessionId: 'sess-1',
      sessionModel: 'session-model',
    });
    expect(inherited.model).toBe('session-model');
    expect(inherited.modelSource).toBe('session');
    expect(inherited.options.model).toBe('session-model');

    vi.stubEnv('WINGMAN_CLAUDE_MODEL', 'from-env');
    const fromEnv = buildClaudeQueryOptions({
      binding: 'resume',
      sessionId: 'sess-1',
      sessionModel: 'session-model',
    });
    expect(fromEnv.model).toBe('from-env');
    expect(fromEnv.modelSource).toBe('env');

    const fromCall = buildClaudeQueryOptions({
      binding: 'resume',
      sessionId: 'sess-1',
      sessionModel: 'session-model',
      turn: { model: 'from-call' },
    });
    expect(fromCall.model).toBe('from-call');
    expect(fromCall.modelSource).toBe('call');
  });

  it('starts a new session without resume or forkSession', () => {
    const plan = buildClaudeQueryOptions({
      binding: 'new',
      sessionId: '11111111-1111-1111-1111-111111111111',
      turn: { forkSession: true, maxTurns: 8, allowedTools: ['Read'], disallowedTools: ['Bash'] },
    });

    expect(plan.resumeMode).toBe('new');
    expect(plan.options.resume).toBeUndefined();
    expect(plan.options.forkSession).toBeUndefined();
    expect(plan.options.sessionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(plan.maxTurns).toBe(8);
    expect(plan.options.allowedTools).toEqual(['Read']);
    expect(plan.options.disallowedTools).toEqual(['Bash']);
  });

  it('forks only when a resume asks for it', () => {
    const plan = buildClaudeQueryOptions({
      binding: 'resume',
      sessionId: 'sess-1',
      turn: { forkSession: true, permissionMode: 'bypassPermissions' },
    });

    expect(plan.resumeMode).toBe('fork');
    expect(plan.options.forkSession).toBe(true);
    expect(plan.options.resume).toBe('sess-1');
    expect(plan.options.allowDangerouslySkipPermissions).toBe(true);
    expect(plan.note).toMatch(/new session id/);
  });

  it('reads a model id from historical session messages and ignores blanks', () => {
    expect(
      extractModelFromSessionMessages([
        { type: 'user', message: { role: 'user', content: 'hi' } },
        { type: 'assistant', message: { role: 'assistant', model: 'session-model', content: [] } },
      ]),
    ).toBe('session-model');
    expect(extractModelFromSessionMessages([{ message: { model: '   ' } }])).toBeUndefined();
    expect(extractModelFromSessionMessages([])).toBeUndefined();
  });
});

describe('ClaudePromptStream', () => {
  it('yields queued messages and then stops', async () => {
    const stream = new ClaudePromptStream();
    stream.push('first');
    stream.push('second', 'now');
    const iterator = stream.iterate();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'user', message: { role: 'user', content: 'first' }, parent_tool_use_id: null },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { message: { content: 'second' }, priority: 'now' },
    });

    const pending = iterator.next();
    stream.finish();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(stream.push('late')).toBe(false);
  });
});
