import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ClaudeProvider session metadata (mock mode)', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('createSession with name and tags creates session with metadata', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    const result = await provider.createSession({
      cwd: '/tmp/test',
      name: 'My Test Session',
      tags: ['test', 'demo'],
    });

    expect(result.provider).toBe('claude');
    expect(result.sessionId).toBeDefined();

    const session = await provider.getSession(result.sessionId);
    expect(session?.name).toBe('My Test Session');
    expect(session?.tags).toEqual(['test', 'demo']);
  });

  it('setSessionMeta updates name on existing session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    const result = await provider.createSession({ cwd: '/tmp/test' });

    const metaResult = await provider.setSessionMeta(result.sessionId, {
      name: 'Updated Name',
    });

    expect(metaResult.updated).toBe(true);
    expect(metaResult.name).toBe('Updated Name');

    const session = await provider.getSession(result.sessionId);
    expect(session?.name).toBe('Updated Name');
  });

  it('setSessionMeta updates tags on existing session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    const result = await provider.createSession({ cwd: '/tmp/test' });

    const metaResult = await provider.setSessionMeta(result.sessionId, {
      tags: ['tag1', 'tag2', 'tag3'],
    });

    expect(metaResult.updated).toBe(true);
    expect(metaResult.tags).toEqual(['tag1', 'tag2', 'tag3']);

    const session = await provider.getSession(result.sessionId);
    expect(session?.tags).toEqual(['tag1', 'tag2', 'tag3']);
  });

  it('setSessionMeta updates both name and tags', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    const result = await provider.createSession({ cwd: '/tmp/test' });

    const metaResult = await provider.setSessionMeta(result.sessionId, {
      name: 'Full Update',
      tags: ['complete', 'metadata'],
    });

    expect(metaResult.updated).toBe(true);
    expect(metaResult.name).toBe('Full Update');
    expect(metaResult.tags).toEqual(['complete', 'metadata']);
  });

  it('setSessionMeta returns error for unknown session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    const result = await provider.setSessionMeta('nonexistent-session', {
      name: 'Test',
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('listSessions includes tags in session info', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    await provider.createSession({
      cwd: '/tmp/test',
      name: 'Tagged Session',
      tags: ['visible', 'in-list'],
    });

    const sessions = await provider.listSessions();
    const tagged = sessions.find((s) => s.name === 'Tagged Session');

    expect(tagged).toBeDefined();
    expect(tagged?.tags).toEqual(['visible', 'in-list']);
  });

  it('setSessionMeta clears tags when set to empty array', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    const result = await provider.createSession({
      cwd: '/tmp/test',
      tags: ['initial', 'tags'],
    });

    await provider.setSessionMeta(result.sessionId, {
      tags: [],
    });

    const session = await provider.getSession(result.sessionId);
    expect(session?.tags).toEqual([]);
  });
});

describe('CodexProvider session metadata (mock mode)', () => {
  beforeEach(() => {
    vi.stubEnv('CODEX_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('createSession with name and tags creates session with metadata', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();

    const result = await provider.createSession({
      cwd: '/tmp/test',
      name: 'Codex Test Session',
      tags: ['codex', 'test'],
    });

    expect(result.provider).toBe('codex');
    expect(result.sessionId).toBeDefined();

    const session = await provider.getSession(result.sessionId);
    expect(session?.name).toBe('Codex Test Session');
    expect(session?.tags).toEqual(['codex', 'test']);
  });

  it('setSessionMeta updates name in mock mode', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();

    const result = await provider.createSession({ cwd: '/tmp/test' });

    const metaResult = await provider.setSessionMeta(result.sessionId, {
      name: 'Renamed Session',
    });

    expect(metaResult.updated).toBe(true);
    expect(metaResult.name).toBe('Renamed Session');
  });

  it('setSessionMeta updates tags in mock mode', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();

    const result = await provider.createSession({ cwd: '/tmp/test' });

    const metaResult = await provider.setSessionMeta(result.sessionId, {
      tags: ['updated', 'tags'],
    });

    expect(metaResult.updated).toBe(true);
    expect(metaResult.tags).toEqual(['updated', 'tags']);
  });

  it('setSessionMeta returns error for unknown session', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();

    const result = await provider.setSessionMeta('nonexistent', {
      name: 'Test',
    });

    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('listSessions includes tags in session info', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();

    await provider.createSession({
      cwd: '/tmp/test',
      name: 'Tagged Codex',
      tags: ['codex', 'tagged'],
    });

    const sessions = await provider.listSessions();
    const tagged = sessions.find((s) => s.name === 'Tagged Codex');

    expect(tagged).toBeDefined();
    expect(tagged?.tags).toEqual(['codex', 'tagged']);
  });
});
