import { describe, it, expect, beforeEach } from 'vitest';
import { createToolHandlers } from '../src/mcp/tools.js';
import type {
  SessionProvider,
  SessionSummary,
  Transcript,
  TranscriptItem,
  SendMessageResult,
  InterruptResult,
  CreateSessionResult,
  ProviderRegistry,
  ProviderName,
} from '../src/providers/types.js';

class MockCodex implements SessionProvider {
  readonly name = 'codex' as const;
  sessions: SessionSummary[] = [
    {
      id: 'thr_test_1',
      provider: 'codex',
      preview: 'hi',
      status: 'idle',
    },
  ];
  messages: string[] = [];

  async listSessions() {
    return this.sessions;
  }
  async readTranscript(sessionId: string, limit = 50): Promise<Transcript> {
    return {
      sessionId,
      provider: 'codex',
      items: this.messages.slice(-limit).map((text) => ({
        role: 'user' as const,
        text,
      })),
    };
  }
  async sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
    this.messages.push(text);
    return { sessionId, turnId: 'turn_1', status: 'completed' };
  }
  async interrupt(sessionId: string): Promise<InterruptResult> {
    return { sessionId, turnId: 'turn_1', status: 'interrupted' };
  }
  async createSession(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    const id = 'thr_created';
    this.sessions.push({ id, provider: 'codex', cwd: opts?.cwd, preview: opts?.prompt });
    return { sessionId: id, provider: 'codex', cwd: opts?.cwd };
  }
}

class MockClaudeDisabled implements SessionProvider {
  readonly name = 'claude' as const;
  async listSessions(): Promise<SessionSummary[]> {
    throw new Error('Claude provider is not yet enabled');
  }
  async readTranscript(): Promise<Transcript> {
    throw new Error('Claude provider is not yet enabled');
  }
  async sendMessage(): Promise<SendMessageResult> {
    throw new Error('Claude provider is not yet enabled');
  }
  async interrupt(): Promise<InterruptResult> {
    throw new Error('Claude provider is not yet enabled');
  }
}

class MockClaudeEnabled implements SessionProvider {
  readonly name = 'claude' as const;
  sessions: SessionSummary[] = [
    {
      id: 'claude_test_1',
      provider: 'claude',
      preview: 'hello claude',
      status: 'idle',
      cwd: '/tmp/claude-test',
    },
  ];
  items: TranscriptItem[] = [
    { role: 'user', text: 'hello claude', turnId: 'turn_1' },
    { role: 'assistant', text: 'Hi! How can I help?', turnId: 'turn_1' },
  ];
  activeTurnId?: string;

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions;
  }
  async readTranscript(sessionId: string, limit = 50): Promise<Transcript> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return {
      sessionId,
      provider: 'claude',
      items: this.items.slice(-Math.max(1, limit)),
    };
  }
  async sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const turnId = `turn_${Date.now()}`;
    this.activeTurnId = turnId;
    this.items.push({ role: 'user', text, turnId });
    this.items.push({ role: 'assistant', text: `[mock] Response to: ${text}`, turnId });
    this.activeTurnId = undefined;
    return { sessionId, turnId, status: 'completed' };
  }
  async interrupt(sessionId: string): Promise<InterruptResult> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const turnId = this.activeTurnId;
    this.activeTurnId = undefined;
    return { sessionId, turnId, status: turnId ? 'interrupted' : 'no_active_turn' };
  }
  async createSession(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    const id = `claude_created_${Date.now()}`;
    this.sessions.push({
      id,
      provider: 'claude',
      cwd: opts?.cwd,
      preview: opts?.prompt,
      status: 'idle',
    });
    if (opts?.prompt) {
      this.items.push({ role: 'user', text: opts.prompt, turnId: 'turn_init' });
      this.items.push({ role: 'assistant', text: '[mock] Session started', turnId: 'turn_init' });
    }
    return { sessionId: id, provider: 'claude', cwd: opts?.cwd };
  }
}

function registry(codex: SessionProvider, claude: SessionProvider): ProviderRegistry {
  return {
    codex,
    claude,
    get(name: ProviderName) {
      return name === 'claude' ? claude : codex;
    },
    all() {
      return [codex, claude];
    },
  };
}

describe('tool handlers with mocked Codex provider', () => {
  let codex: MockCodex;
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    codex = new MockCodex();
    handlers = createToolHandlers(registry(codex, new MockClaudeDisabled()));
  });

  it('list_sessions returns codex sessions', async () => {
    const res = await handlers.list_sessions({ provider: 'codex' });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe('thr_test_1');
  });

  it('list_sessions without provider includes claude stub marker when disabled', async () => {
    const res = await handlers.list_sessions({});
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessions.some((s: { provider: string }) => s.provider === 'codex')).toBe(true);
    expect(body.sessions.some((s: { id: string }) => s.id === '_claude_stub')).toBe(true);
  });

  it('send_message forwards text', async () => {
    const res = await handlers.send_message({
      provider: 'codex',
      session_id: 'thr_test_1',
      text: 'run tests',
    });
    expect(res.isError).toBeUndefined();
    expect(codex.messages).toEqual(['run tests']);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('completed');
  });

  it('read_transcript returns items', async () => {
    await handlers.send_message({
      provider: 'codex',
      session_id: 'thr_test_1',
      text: 'hello',
    });
    const res = await handlers.read_transcript({
      provider: 'codex',
      session_id: 'thr_test_1',
      limit: 10,
    });
    const body = JSON.parse(res.content[0]!.text);
    expect(body.items[0].text).toBe('hello');
  });

  it('interrupt returns interrupted', async () => {
    const res = await handlers.interrupt({
      provider: 'codex',
      session_id: 'thr_test_1',
    });
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('interrupted');
  });

  it('create_session creates id', async () => {
    const res = await handlers.create_session({
      provider: 'codex',
      cwd: '/tmp/demo',
      prompt: 'hi',
    });
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('thr_created');
  });

  it('claude send_message returns error when disabled', async () => {
    const res = await handlers.send_message({
      provider: 'claude',
      session_id: 'x',
      text: 'hi',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not yet enabled/i);
  });
});

describe('tool handlers with mocked Claude provider (enabled)', () => {
  let claude: MockClaudeEnabled;
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    claude = new MockClaudeEnabled();
    handlers = createToolHandlers(registry(new MockCodex(), claude));
  });

  it('list_sessions returns claude sessions', async () => {
    const res = await handlers.list_sessions({ provider: 'claude' });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe('claude_test_1');
    expect(body.sessions[0].provider).toBe('claude');
  });

  it('list_sessions without provider includes both providers', async () => {
    const res = await handlers.list_sessions({});
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessions.some((s: { provider: string }) => s.provider === 'codex')).toBe(true);
    expect(body.sessions.some((s: { provider: string }) => s.provider === 'claude')).toBe(true);
    expect(body.sessions.some((s: { id: string }) => s.id === '_claude_stub')).toBe(false);
  });

  it('read_transcript returns claude items', async () => {
    const res = await handlers.read_transcript({
      provider: 'claude',
      session_id: 'claude_test_1',
      limit: 10,
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.provider).toBe('claude');
    expect(body.items).toHaveLength(2);
    expect(body.items[0].text).toBe('hello claude');
  });

  it('send_message sends to claude session', async () => {
    const res = await handlers.send_message({
      provider: 'claude',
      session_id: 'claude_test_1',
      text: 'test message',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('completed');
    expect(claude.items.some((i) => i.text === 'test message')).toBe(true);
  });

  it('interrupt returns status for claude session', async () => {
    const res = await handlers.interrupt({
      provider: 'claude',
      session_id: 'claude_test_1',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('no_active_turn');
  });

  it('create_session creates claude session', async () => {
    const res = await handlers.create_session({
      provider: 'claude',
      cwd: '/tmp/claude-new',
      prompt: 'start new session',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.provider).toBe('claude');
    expect(body.cwd).toBe('/tmp/claude-new');
    expect(claude.sessions.some((s) => s.id === body.sessionId)).toBe(true);
  });

  it('read_transcript errors for unknown session', async () => {
    const res = await handlers.read_transcript({
      provider: 'claude',
      session_id: 'nonexistent',
      limit: 10,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unknown session/i);
  });
});
