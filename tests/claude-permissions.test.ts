import { describe, it, expect } from 'vitest';
import { ClaudePermissionBroker } from '../src/providers/claude-permissions.js';

function request(
  broker: ClaudePermissionBroker,
  overrides: Partial<Parameters<ClaudePermissionBroker['request']>[0]> = {},
) {
  const controller = new AbortController();
  const pending = broker.request({
    toolName: 'Bash',
    input: { command: 'git status' },
    sessionId: 'sess-1',
    turnId: 'turn-1',
    signal: controller.signal,
    timeoutMs: 2_000,
    title: 'Claude wants to run git status',
    ...overrides,
  });
  return { controller, pending };
}

describe('ClaudePermissionBroker', () => {
  it('lists a command prompt and accepts it once', async () => {
    const broker = new ClaudePermissionBroker();
    const { pending } = request(broker);

    const listed = broker.list('sess-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      sessionId: 'sess-1',
      turnId: 'turn-1',
      kind: 'command',
      toolName: 'Bash',
      command: 'git status',
      reason: 'Claude wants to run git status',
    });

    const resolved = broker.resolve('sess-1', listed[0]!.id, 'accept');
    expect(resolved).toMatchObject({ resolved: true, decision: 'accept' });
    expect(broker.list('sess-1')).toEqual([]);

    const decision = await pending;
    expect(decision.behavior).toBe('allow');
    expect(decision.decisionClassification).toBe('user_temporary');
  });

  it('remember an acceptForSession rule and still prompts for a different command', async () => {
    const broker = new ClaudePermissionBroker();
    const first = request(broker);
    const id = broker.list('sess-1')[0]!.id;
    broker.resolve('sess-1', id, 'acceptForSession');
    await expect(first.pending).resolves.toMatchObject({
      behavior: 'allow',
      decisionClassification: 'user_permanent',
    });

    const again = await broker.request({
      toolName: 'Bash',
      input: { command: 'git status' },
      sessionId: 'sess-1',
      signal: new AbortController().signal,
    });
    expect(again.behavior).toBe('allow');
    expect(broker.list('sess-1')).toEqual([]);

    const other = request(broker, { input: { command: 'git push' } });
    expect(broker.list('sess-1')).toHaveLength(1);
    broker.resolve('sess-1', broker.list('sess-1')[0]!.id, 'decline');
    await expect(other.pending).resolves.toMatchObject({
      behavior: 'deny',
      message: 'Denied by Wingman supervisor.',
    });
  });

  it('maps file and network tools onto the existing approval kinds', () => {
    const broker = new ClaudePermissionBroker();
    request(broker, {
      toolName: 'Edit',
      input: { file_path: 'C:\\Users\\me\\src\\app.ts' },
      title: undefined,
    });
    request(broker, {
      toolName: 'WebFetch',
      input: { url: 'https://example.com' },
      sessionId: 'sess-2',
    });

    expect(broker.list('sess-1')[0]).toMatchObject({
      kind: 'fileChange',
      toolName: 'Edit',
    });
    expect(broker.list('sess-2')[0]).toMatchObject({
      kind: 'network',
      toolName: 'WebFetch',
    });
    broker.cancelSession('sess-1');
    broker.cancelSession('sess-2');
  });

  it('denies when the timeout elapses', async () => {
    const broker = new ClaudePermissionBroker();
    const { pending } = request(broker, { timeoutMs: 20 });
    const decision = await pending;
    expect(decision).toMatchObject({
      behavior: 'deny',
      message: 'Wingman approval timed out; denied.',
    });
    expect(broker.list('sess-1')).toEqual([]);
  });

  it('denies when the turn is aborted or interrupted', async () => {
    const broker = new ClaudePermissionBroker();
    const aborted = request(broker);
    aborted.controller.abort();
    await expect(aborted.pending).resolves.toMatchObject({
      behavior: 'deny',
      message: 'Turn aborted before approval.',
    });

    const open = request(broker, { sessionId: 'sess-2' });
    broker.cancelSession('sess-2');
    await expect(open.pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('cancel denies and asks the CLI to interrupt', async () => {
    const broker = new ClaudePermissionBroker();
    const { pending } = request(broker);
    const id = broker.list('sess-1')[0]!.id;
    expect(broker.resolve('sess-1', id, 'cancel').resolved).toBe(true);
    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: true,
    });
  });

  it('returns not found for an unknown approval', () => {
    const broker = new ClaudePermissionBroker();
    expect(broker.resolve('sess-1', 'missing', 'accept')).toMatchObject({
      resolved: false,
      error: 'Approval not found: missing',
    });
  });
});
