import { describe, it, expect, beforeEach } from 'vitest';
import { createToolHandlers } from '../src/mcp/tools.js';
import type {
  SessionProvider,
  SessionSummary,
  SessionDetail,
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
  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    return { ...session, status: 'idle' };
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
    return { sessionId: id, provider: 'codex', cwd: opts?.cwd, status: opts?.prompt ? 'accepted' : 'created' };
  }
}

class MockClaudeWithDiscovery implements SessionProvider {
  readonly name = 'claude' as const;
  wingmanSessions: SessionSummary[] = [
    {
      id: 'sess_wingman_1',
      provider: 'claude',
      cwd: '/home/user/project-a',
      name: 'Wingman Session A',
      preview: 'wingman prompt',
      status: 'idle',
      source: 'wingman',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
    },
  ];
  discoveredSessions: SessionSummary[] = [
    {
      id: 'sess_discovered_1',
      provider: 'claude',
      cwd: '/home/user/project-b',
      name: 'Discovered Session B',
      preview: 'discovered prompt',
      status: 'idle',
      source: 'discovered',
      gitBranch: 'main',
      tag: 'test',
      createdAt: Date.now() - 2000,
      updatedAt: Date.now() - 100,
    },
    {
      id: 'sess_discovered_2',
      provider: 'claude',
      cwd: '/home/user/project-c',
      name: 'Discovered Session C',
      preview: 'another discovered prompt',
      status: 'idle',
      source: 'discovered',
      gitBranch: 'feature',
      createdAt: Date.now() - 3000,
      updatedAt: Date.now() - 2000,
    },
  ];
  transcripts = new Map<string, TranscriptItem[]>([
    ['sess_wingman_1', [{ role: 'user', text: 'wingman prompt' }, { role: 'assistant', text: 'wingman response' }]],
    ['sess_discovered_1', [{ role: 'user', text: 'discovered prompt' }, { role: 'assistant', text: 'discovered response' }]],
    ['sess_discovered_2', [{ role: 'user', text: 'another discovered prompt' }]],
  ]);
  messages: string[] = [];

  async listSessions(): Promise<SessionSummary[]> {
    const wingmanIds = new Set(this.wingmanSessions.map((s) => s.id));
    const merged = [...this.wingmanSessions];
    for (const ds of this.discoveredSessions) {
      if (!wingmanIds.has(ds.id)) {
        merged.push(ds);
      }
    }
    merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return merged;
  }

  async readTranscript(sessionId: string, limit = 50): Promise<Transcript> {
    const items = this.transcripts.get(sessionId);
    if (!items) throw new Error(`Unknown session: ${sessionId}`);
    return {
      sessionId,
      provider: 'claude',
      items: items.slice(-limit),
    };
  }

  async sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
    const items = this.transcripts.get(sessionId);
    if (!items) throw new Error(`Unknown session: ${sessionId}`);
    items.push({ role: 'user', text });
    items.push({ role: 'assistant', text: `[mock] Received: ${text}` });
    this.messages.push(text);
    return { sessionId, turnId: 'turn_mock', status: 'completed' };
  }

  async interrupt(sessionId: string): Promise<InterruptResult> {
    return { sessionId, turnId: 'turn_mock', status: 'interrupted' };
  }

  async createSession(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    const id = 'sess_created';
    this.wingmanSessions.push({
      id,
      provider: 'claude',
      cwd: opts?.cwd,
      preview: opts?.prompt,
      source: 'wingman',
    });
    this.transcripts.set(id, []);
    return {
      sessionId: id,
      provider: 'claude',
      cwd: opts?.cwd,
      status: opts?.prompt ? 'accepted' : 'created',
      turnId: opts?.prompt ? 'turn_initial' : undefined,
    };
  }
  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    return { ...session, status: 'idle' };
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
      source: 'wingman',
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
  async createSession(opts?: { cwd?: string; prompt?: string; name?: string; tags?: string[] }): Promise<CreateSessionResult> {
    const id = `claude_created_${Date.now()}`;
    this.sessions.push({
      id,
      provider: 'claude',
      cwd: opts?.cwd,
      preview: opts?.prompt,
      name: opts?.name,
      tags: opts?.tags,
      status: 'idle',
      source: 'wingman',
    });
    if (opts?.prompt) {
      this.items.push({ role: 'user', text: opts.prompt, turnId: 'turn_init' });
      this.items.push({ role: 'assistant', text: '[mock] Session started', turnId: 'turn_init' });
    }
    return {
      sessionId: id,
      provider: 'claude',
      cwd: opts?.cwd,
      status: opts?.prompt ? 'accepted' : 'created',
      turnId: opts?.prompt ? 'turn_init' : undefined,
    };
  }
  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    return { ...session, status: this.activeTurnId ? 'running' : 'idle', activeTurnId: this.activeTurnId };
  }
  async waitTurn(sessionId: string, _opts?: WaitTurnOptions): Promise<WaitTurnResult> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (!this.activeTurnId) {
      const lastAssistant = [...this.items].reverse().find((i) => i.role === 'assistant');
      return { sessionId, status: 'idle', latestMessage: lastAssistant?.text?.slice(0, 200) };
    }
    return { sessionId, turnId: this.activeTurnId, status: 'completed', latestMessage: '[mock] completed' };
  }
  async steer(sessionId: string, _text: string): Promise<SteerResult> {
    return {
      sessionId,
      accepted: false,
      error: 'Claude does not support mid-turn steering. Use interrupt() then send_message().',
    };
  }
  async listApprovals(sessionId: string): Promise<ListApprovalsResult> {
    return { sessionId, approvals: [] };
  }
  async resolveApproval(sessionId: string, approvalId: string, _decision: ApprovalDecision): Promise<ResolveApprovalResult> {
    return {
      sessionId,
      approvalId,
      resolved: false,
      error: 'Claude does not support programmatic approval resolution.',
    };
  }
  async setSessionMeta(sessionId: string, meta: SetSessionMetaOptions): Promise<SetSessionMetaResult> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return { sessionId, updated: false, error: `Session not found: ${sessionId}` };
    }
    if (meta.name !== undefined) session.name = meta.name;
    if (meta.tags !== undefined) session.tags = meta.tags;
    return { sessionId, updated: true, name: session.name, tags: session.tags };
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
    expect(body.status).toBe('accepted');
  });

  it('create_session without prompt returns created status', async () => {
    const res = await handlers.create_session({
      provider: 'codex',
      cwd: '/tmp/demo',
    });
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('thr_created');
    expect(body.status).toBe('created');
    expect(body.turnId).toBeUndefined();
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
    expect(body.status).toBe('accepted');
    expect(body.turnId).toBeDefined();
    expect(claude.sessions.some((s) => s.id === body.sessionId)).toBe(true);
  });

  it('create_session without prompt returns created status for claude', async () => {
    const res = await handlers.create_session({
      provider: 'claude',
      cwd: '/tmp/claude-new',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.provider).toBe('claude');
    expect(body.status).toBe('created');
    expect(body.turnId).toBeUndefined();
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

  it('get_session returns session details', async () => {
    const res = await handlers.get_session({
      provider: 'claude',
      session_id: 'claude_test_1',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.id).toBe('claude_test_1');
    expect(body.provider).toBe('claude');
    expect(body.status).toBeDefined();
  });

  it('get_session returns error for unknown session', async () => {
    const res = await handlers.get_session({
      provider: 'claude',
      session_id: 'nonexistent',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not found/i);
  });
});

describe('Claude session discovery with mocked provider', () => {
  let claude: MockClaudeWithDiscovery;
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    claude = new MockClaudeWithDiscovery();
    handlers = createToolHandlers(registry(new MockCodex(), claude));
  });

  it('list_sessions returns merged wingman + discovered sessions', async () => {
    const res = await handlers.list_sessions({ provider: 'claude' });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessions.length).toBe(3);

    const wingman = body.sessions.find((s: SessionSummary) => s.id === 'sess_wingman_1');
    expect(wingman).toBeDefined();
    expect(wingman.source).toBe('wingman');

    const discovered1 = body.sessions.find((s: SessionSummary) => s.id === 'sess_discovered_1');
    expect(discovered1).toBeDefined();
    expect(discovered1.source).toBe('discovered');
    expect(discovered1.gitBranch).toBe('main');
    expect(discovered1.tag).toBe('test');

    const discovered2 = body.sessions.find((s: SessionSummary) => s.id === 'sess_discovered_2');
    expect(discovered2).toBeDefined();
    expect(discovered2.source).toBe('discovered');
  });

  it('list_sessions deduplicates by id (wingman takes precedence)', async () => {
    claude.discoveredSessions.push({
      id: 'sess_wingman_1',
      provider: 'claude',
      cwd: '/different/path',
      name: 'Duplicate Discovered',
      preview: 'should be ignored',
      status: 'idle',
      source: 'discovered',
      updatedAt: Date.now(),
    });

    const res = await handlers.list_sessions({ provider: 'claude' });
    const body = JSON.parse(res.content[0]!.text);

    const matches = body.sessions.filter((s: SessionSummary) => s.id === 'sess_wingman_1');
    expect(matches.length).toBe(1);
    expect(matches[0].source).toBe('wingman');
    expect(matches[0].name).toBe('Wingman Session A');
  });

  it('list_sessions sorts by updatedAt descending', async () => {
    const res = await handlers.list_sessions({ provider: 'claude' });
    const body = JSON.parse(res.content[0]!.text);

    expect(body.sessions[0].id).toBe('sess_discovered_1');
    expect(body.sessions[1].id).toBe('sess_wingman_1');
    expect(body.sessions[2].id).toBe('sess_discovered_2');
  });

  it('read_transcript works for discovered sessions', async () => {
    const res = await handlers.read_transcript({
      provider: 'claude',
      session_id: 'sess_discovered_1',
      limit: 10,
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('sess_discovered_1');
    expect(body.items.length).toBe(2);
    expect(body.items[0].text).toBe('discovered prompt');
    expect(body.items[1].text).toBe('discovered response');
  });

  it('read_transcript works for wingman sessions', async () => {
    const res = await handlers.read_transcript({
      provider: 'claude',
      session_id: 'sess_wingman_1',
      limit: 10,
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('sess_wingman_1');
    expect(body.items.length).toBe(2);
  });

  it('send_message works for discovered sessions', async () => {
    const res = await handlers.send_message({
      provider: 'claude',
      session_id: 'sess_discovered_1',
      text: 'test message to discovered',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('sess_discovered_1');
    expect(body.status).toBe('completed');
    expect(claude.messages).toContain('test message to discovered');
  });

  it('interrupt works for discovered sessions', async () => {
    const res = await handlers.interrupt({
      provider: 'claude',
      session_id: 'sess_discovered_1',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('sess_discovered_1');
    expect(body.status).toBe('interrupted');
  });

  it('create_session creates wingman-owned session', async () => {
    const res = await handlers.create_session({
      provider: 'claude',
      cwd: '/tmp/new-project',
      prompt: 'initial prompt',
    });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('sess_created');
    expect(body.provider).toBe('claude');

    const listRes = await handlers.list_sessions({ provider: 'claude' });
    const listBody = JSON.parse(listRes.content[0]!.text);
    const created = listBody.sessions.find((s: SessionSummary) => s.id === 'sess_created');
    expect(created).toBeDefined();
    expect(created.source).toBe('wingman');
  });

  it('sessions include new fields: source, gitBranch, tag', async () => {
    const res = await handlers.list_sessions({ provider: 'claude' });
    const body = JSON.parse(res.content[0]!.text);

    for (const session of body.sessions) {
      expect(session).toHaveProperty('source');
      expect(['wingman', 'discovered']).toContain(session.source);
    }

    const discovered = body.sessions.find((s: SessionSummary) => s.id === 'sess_discovered_1');
    expect(discovered.gitBranch).toBe('main');
    expect(discovered.tag).toBe('test');
  });
});

import type {
  WaitTurnResult,
  SteerResult,
  ListApprovalsResult,
  ResolveApprovalResult,
  SetSessionMetaResult,
  SetSessionMetaOptions,
  Approval,
  ApprovalDecision,
  WaitTurnOptions,
} from '../src/providers/types.js';

class MockCodexWithApprovals implements SessionProvider {
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
  activeTurnId?: string;
  pendingApprovals: Approval[] = [];

  async listSessions() {
    return this.sessions;
  }
  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    return { ...session, status: this.activeTurnId ? 'running' : 'idle', activeTurnId: this.activeTurnId };
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
    const turnId = 'turn_test';
    this.activeTurnId = turnId;
    
    // Simulate approval if sudo in message
    if (text.includes('sudo')) {
      this.pendingApprovals.push({
        id: 'appr_test_1',
        sessionId,
        turnId,
        kind: 'command',
        command: text,
        reason: 'Needs approval',
        requestedAt: Date.now(),
      });
    }
    
    return { sessionId, turnId, status: 'inProgress' };
  }
  async interrupt(sessionId: string): Promise<InterruptResult> {
    const turnId = this.activeTurnId;
    this.activeTurnId = undefined;
    return { sessionId, turnId, status: 'interrupted' };
  }
  async createSession(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    const id = 'thr_created';
    this.sessions.push({ id, provider: 'codex', cwd: opts?.cwd, preview: opts?.prompt });
    return { sessionId: id, provider: 'codex', cwd: opts?.cwd, status: opts?.prompt ? 'accepted' : 'created' };
  }
  
  async waitTurn(sessionId: string, opts?: WaitTurnOptions): Promise<WaitTurnResult> {
    if (this.pendingApprovals.length > 0) {
      return {
        sessionId,
        turnId: this.activeTurnId,
        status: 'inProgress' as WaitTurnResult['status'],
        latestMessage: `Waiting for ${this.pendingApprovals.length} approval(s)`,
      };
    }
    if (!this.activeTurnId) {
      return { sessionId, status: 'idle' };
    }
    // Simulate turn completion
    this.activeTurnId = undefined;
    return { sessionId, turnId: 'turn_test', status: 'completed', latestMessage: 'Done' };
  }
  
  async steer(sessionId: string, text: string): Promise<SteerResult> {
    if (!this.activeTurnId) {
      return { sessionId, accepted: false, error: 'No active turn' };
    }
    this.messages.push(`[steer] ${text}`);
    return { sessionId, turnId: this.activeTurnId, accepted: true };
  }
  
  async listApprovals(sessionId: string): Promise<ListApprovalsResult> {
    return { sessionId, approvals: this.pendingApprovals.filter(a => a.sessionId === sessionId) };
  }
  
  async resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<ResolveApprovalResult> {
    const idx = this.pendingApprovals.findIndex(a => a.id === approvalId);
    if (idx === -1) {
      return { sessionId, approvalId, resolved: false, error: 'Approval not found' };
    }
    this.pendingApprovals.splice(idx, 1);
    if (decision === 'decline' || decision === 'cancel') {
      this.activeTurnId = undefined;
    }
    return { sessionId, approvalId, resolved: true, decision };
  }
}

describe('tool handlers for Codex wait/steer/approvals', () => {
  let codex: MockCodexWithApprovals;
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    codex = new MockCodexWithApprovals();
    handlers = createToolHandlers(registry(codex, new MockClaudeDisabled()));
  });

  it('wait_turn returns completed when turn finishes', async () => {
    await handlers.send_message({ provider: 'codex', session_id: 'thr_test_1', text: 'test' });
    
    const res = await handlers.wait_turn({ provider: 'codex', session_id: 'thr_test_1' });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('completed');
  });

  it('wait_turn returns idle when no active turn', async () => {
    const res = await handlers.wait_turn({ provider: 'codex', session_id: 'thr_test_1' });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('idle');
  });

  it('steer adds guidance to active turn', async () => {
    await handlers.send_message({ provider: 'codex', session_id: 'thr_test_1', text: 'task' });
    
    const res = await handlers.steer({ provider: 'codex', session_id: 'thr_test_1', text: 'guidance' });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.accepted).toBe(true);
    expect(codex.messages.some(m => m.includes('[steer]'))).toBe(true);
  });

  it('steer returns error when no active turn', async () => {
    const res = await handlers.steer({ provider: 'codex', session_id: 'thr_test_1', text: 'guidance' });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.accepted).toBe(false);
    expect(body.error).toMatch(/no active turn/i);
  });

  it('list_approvals returns pending approvals', async () => {
    await handlers.send_message({ provider: 'codex', session_id: 'thr_test_1', text: 'sudo test' });
    
    const res = await handlers.list_approvals({ provider: 'codex', session_id: 'thr_test_1' });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.approvals.length).toBe(1);
    expect(body.approvals[0].kind).toBe('command');
  });

  it('list_approvals returns empty array when none pending', async () => {
    const res = await handlers.list_approvals({ provider: 'codex', session_id: 'thr_test_1' });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.approvals).toEqual([]);
  });

  it('resolve_approval accepts and clears approval', async () => {
    await handlers.send_message({ provider: 'codex', session_id: 'thr_test_1', text: 'sudo test' });
    
    const res = await handlers.resolve_approval({
      provider: 'codex',
      session_id: 'thr_test_1',
      approval_id: 'appr_test_1',
      decision: 'accept',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.resolved).toBe(true);
    expect(body.decision).toBe('accept');
    
    // Verify approval is cleared
    const listRes = await handlers.list_approvals({ provider: 'codex', session_id: 'thr_test_1' });
    const listBody = JSON.parse(listRes.content[0]!.text);
    expect(listBody.approvals.length).toBe(0);
  });

  it('resolve_approval decline ends turn', async () => {
    await handlers.send_message({ provider: 'codex', session_id: 'thr_test_1', text: 'sudo test' });
    
    await handlers.resolve_approval({
      provider: 'codex',
      session_id: 'thr_test_1',
      approval_id: 'appr_test_1',
      decision: 'decline',
    });
    
    const sessionRes = await handlers.get_session({ provider: 'codex', session_id: 'thr_test_1' });
    const sessionBody = JSON.parse(sessionRes.content[0]!.text);
    expect(sessionBody.status).toBe('idle');
  });

  it('resolve_approval returns error for unknown approval', async () => {
    const res = await handlers.resolve_approval({
      provider: 'codex',
      session_id: 'thr_test_1',
      approval_id: 'nonexistent',
      decision: 'accept',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.resolved).toBe(false);
    expect(body.error).toMatch(/not found/i);
  });

  it('wait_turn indicates pending approvals', async () => {
    await handlers.send_message({ provider: 'codex', session_id: 'thr_test_1', text: 'sudo test' });
    
    const res = await handlers.wait_turn({ provider: 'codex', session_id: 'thr_test_1' });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.latestMessage).toMatch(/approval/i);
  });
});

describe('tool handlers for Claude wait/steer/approvals parity', () => {
  let claude: MockClaudeEnabled;
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    claude = new MockClaudeEnabled();
    handlers = createToolHandlers(registry(new MockCodex(), claude));
  });

  it('wait_turn returns idle for Claude session with no active turn', async () => {
    const res = await handlers.wait_turn({
      provider: 'claude',
      session_id: 'claude_test_1',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('idle');
    expect(body.sessionId).toBe('claude_test_1');
  });

  it('wait_turn returns completed with message for Claude session', async () => {
    // Simulate an active turn
    claude.activeTurnId = 'turn_test';
    
    const res = await handlers.wait_turn({
      provider: 'claude',
      session_id: 'claude_test_1',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe('completed');
    expect(body.latestMessage).toBeDefined();
  });

  it('steer returns unsupported error for Claude', async () => {
    const res = await handlers.steer({
      provider: 'claude',
      session_id: 'claude_test_1',
      text: 'guidance',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.accepted).toBe(false);
    expect(body.error).toMatch(/claude does not support/i);
  });

  it('list_approvals returns empty array for Claude', async () => {
    const res = await handlers.list_approvals({
      provider: 'claude',
      session_id: 'claude_test_1',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.sessionId).toBe('claude_test_1');
    expect(body.approvals).toEqual([]);
  });

  it('resolve_approval returns unsupported error for Claude', async () => {
    const res = await handlers.resolve_approval({
      provider: 'claude',
      session_id: 'claude_test_1',
      approval_id: 'any_id',
      decision: 'accept',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.resolved).toBe(false);
    expect(body.error).toMatch(/claude does not support/i);
  });
});

describe('tool handlers for set_session_meta', () => {
  let claude: MockClaudeEnabled;
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    claude = new MockClaudeEnabled();
    handlers = createToolHandlers(registry(new MockCodex(), claude));
  });

  it('set_session_meta updates name', async () => {
    const res = await handlers.set_session_meta({
      provider: 'claude',
      session_id: 'claude_test_1',
      name: 'Renamed Session',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.updated).toBe(true);
    expect(body.name).toBe('Renamed Session');
  });

  it('set_session_meta updates tags', async () => {
    const res = await handlers.set_session_meta({
      provider: 'claude',
      session_id: 'claude_test_1',
      tags: ['tag1', 'tag2'],
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.updated).toBe(true);
    expect(body.tags).toEqual(['tag1', 'tag2']);
  });

  it('set_session_meta updates both name and tags', async () => {
    const res = await handlers.set_session_meta({
      provider: 'claude',
      session_id: 'claude_test_1',
      name: 'Full Update',
      tags: ['a', 'b', 'c'],
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.updated).toBe(true);
    expect(body.name).toBe('Full Update');
    expect(body.tags).toEqual(['a', 'b', 'c']);
  });

  it('set_session_meta returns error for unknown session', async () => {
    const res = await handlers.set_session_meta({
      provider: 'claude',
      session_id: 'nonexistent',
      name: 'Test',
    });
    expect(res.isError).toBeUndefined();
    
    const body = JSON.parse(res.content[0]!.text);
    expect(body.updated).toBe(false);
    expect(body.error).toMatch(/not found/i);
  });

  it('set_session_meta returns error for unsupported provider', async () => {
    const disabledClaude = new MockClaudeDisabled();
    const handlersWithDisabled = createToolHandlers(registry(new MockCodex(), disabledClaude));
    
    const res = await handlersWithDisabled.set_session_meta({
      provider: 'claude',
      session_id: 'test',
      name: 'Test',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not supported/i);
  });

  it('create_session with name and tags persists metadata', async () => {
    const createRes = await handlers.create_session({
      provider: 'claude',
      cwd: '/tmp/test',
      name: 'Named Session',
      tags: ['created', 'with-tags'],
    });
    expect(createRes.isError).toBeUndefined();
    
    const createBody = JSON.parse(createRes.content[0]!.text);
    expect(createBody.sessionId).toBeDefined();
    
    const listRes = await handlers.list_sessions({ provider: 'claude' });
    const listBody = JSON.parse(listRes.content[0]!.text);
    const created = listBody.sessions.find((s: SessionSummary) => s.id === createBody.sessionId);
    
    expect(created).toBeDefined();
    expect(created.name).toBe('Named Session');
    expect(created.tags).toEqual(['created', 'with-tags']);
  });
});
