import { describe, it, expect, beforeEach } from 'vitest';
import { createToolHandlers } from '../src/mcp/tools.js';
import type {
  SessionProvider,
  SessionSummary,
  Transcript,
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

describe('tool handlers with mocked providers', () => {
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

  it('list_sessions without provider includes claude stub marker', async () => {
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

  it('claude send_message returns error', async () => {
    const res = await handlers.send_message({
      provider: 'claude',
      session_id: 'x',
      text: 'hi',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not yet enabled/i);
  });
});
