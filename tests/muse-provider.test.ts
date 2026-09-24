import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('MuseProvider mock mode', () => {
  beforeEach(() => {
    vi.stubEnv('MUSE_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('listSessions returns mock sessions', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    const sessions = await provider.listSessions();
    
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].provider).toBe('muse');
    expect(sessions[0].id).toMatch(/^muse_mock_/);
  });

  it('createSession creates a new mock session', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Hello Muse',
    });
    
    expect(result.provider).toBe('muse');
    expect(result.cwd).toBe('/tmp/test');
    expect(result.sessionId).toMatch(/^muse_mock_/);
    
    const sessions = await provider.listSessions();
    expect(sessions.some(s => s.id === result.sessionId)).toBe(true);
  });

  it('sendMessage returns accepted and processes in background', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const result = await provider.sendMessage(sessionId, 'Test message');
    
    expect(result.sessionId).toBe(sessionId);
    expect(result.status).toBe('accepted');
    expect(result.turnId).toBeDefined();
    
    const transcript = await provider.readTranscript(sessionId, 50);
    expect(transcript.items.some(i => i.text === 'Test message')).toBe(true);
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const transcriptAfter = await provider.readTranscript(sessionId, 50);
    expect(transcriptAfter.items.some(i => i.text.includes('[mock Muse]'))).toBe(true);
  });

  it('readTranscript returns items for mock session', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const transcript = await provider.readTranscript(sessionId, 50);
    
    expect(transcript.provider).toBe('muse');
    expect(transcript.sessionId).toBe(sessionId);
    expect(transcript.items.length).toBeGreaterThan(0);
  });

  it('interrupt returns status for mock session', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const result = await provider.interrupt(sessionId);
    
    expect(result.sessionId).toBe(sessionId);
    expect(result.status).toBe('interrupted');
  });

  it('readTranscript throws for unknown session', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.readTranscript('nonexistent')).rejects.toThrow(/unknown mock session/i);
  });

  it('readTranscript returns messages in chronological order (oldest first, newest last)', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'First message',
    });
    
    await new Promise(resolve => setTimeout(resolve, 60));
    
    await provider.sendMessage(result.sessionId, 'Second message');
    await new Promise(resolve => setTimeout(resolve, 60));
    
    await provider.sendMessage(result.sessionId, 'Third message');
    await new Promise(resolve => setTimeout(resolve, 60));
    
    const transcript = await provider.readTranscript(result.sessionId, 50);
    
    const userMessages = transcript.items.filter(i => i.role === 'user').map(i => i.text);
    expect(userMessages).toEqual(['First message', 'Second message', 'Third message']);
    
    const firstUserIndex = transcript.items.findIndex(i => i.role === 'user' && i.text === 'First message');
    const lastUserIndex = transcript.items.findIndex(i => i.role === 'user' && i.text === 'Third message');
    expect(firstUserIndex).toBeLessThan(lastUserIndex);
  });

  it('readTranscript with limit returns most recent messages', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Message 1',
    });
    
    await new Promise(resolve => setTimeout(resolve, 60));
    await provider.sendMessage(result.sessionId, 'Message 2');
    await new Promise(resolve => setTimeout(resolve, 60));
    await provider.sendMessage(result.sessionId, 'Message 3');
    await new Promise(resolve => setTimeout(resolve, 60));
    
    const transcript = await provider.readTranscript(result.sessionId, 4);
    
    const userMessages = transcript.items.filter(i => i.role === 'user').map(i => i.text);
    expect(userMessages.includes('Message 3')).toBe(true);
    expect(userMessages[userMessages.length - 1]).toBe('Message 3');
  });

  it('getSession returns session details with status', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const session = await provider.getSession(sessionId);
    
    expect(session).not.toBeNull();
    expect(session?.id).toBe(sessionId);
    expect(session?.provider).toBe('muse');
    expect(session?.status).toBe('idle');
  });

  it('getSession shows running status during active turn', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    const sendPromise = provider.sendMessage(result.sessionId, 'test');
    
    const session = await provider.getSession(result.sessionId);
    expect(session?.status).toBe('running');
    expect(session?.activeTurnId).toBeDefined();
    
    await sendPromise;
    await new Promise(resolve => setTimeout(resolve, 60));
    
    const sessionAfter = await provider.getSession(result.sessionId);
    expect(sessionAfter?.status).toBe('idle');
  });

  it('interrupt stops active turn and returns turnId', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    const sendResult = await provider.sendMessage(result.sessionId, 'long task');
    expect(sendResult.status).toBe('accepted');
    
    const interruptResult = await provider.interrupt(result.sessionId);
    
    expect(interruptResult.sessionId).toBe(result.sessionId);
    expect(interruptResult.status).toBe('interrupted');
    expect(interruptResult.turnId).toBeDefined();
    
    const session = await provider.getSession(result.sessionId);
    expect(session?.status).toBe('idle');
  });

  it('getSessionStatus returns correct status', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    expect(provider.getSessionStatus(result.sessionId)).toBe('idle');
    
    const sendPromise = provider.sendMessage(result.sessionId, 'test');
    expect(provider.getSessionStatus(result.sessionId)).toBe('running');
    
    await sendPromise;
    await new Promise(resolve => setTimeout(resolve, 60));
    
    expect(provider.getSessionStatus(result.sessionId)).toBe('idle');
  });

  it('createSession without prompt returns status created', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    expect(result.provider).toBe('muse');
    expect(result.status).toBe('created');
    expect(result.turnId).toBeUndefined();
    expect(provider.getSessionStatus(result.sessionId)).toBe('idle');
  });

  it('createSession with prompt returns accepted quickly with turnId', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const startTime = Date.now();
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Hello Muse',
    });
    const elapsed = Date.now() - startTime;
    
    expect(result.provider).toBe('muse');
    expect(result.status).toBe('accepted');
    expect(result.turnId).toBeDefined();
    expect(result.sessionId).toMatch(/^muse_mock_/);
    expect(elapsed).toBeLessThan(100);
  });

  it('createSession with prompt starts turn in background', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Test background turn',
    });
    
    expect(provider.getSessionStatus(result.sessionId)).toBe('running');
    
    const transcript = await provider.readTranscript(result.sessionId, 50);
    expect(transcript.items.some(i => i.text === 'Test background turn')).toBe(true);
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    expect(provider.getSessionStatus(result.sessionId)).toBe('idle');
    
    const transcriptAfter = await provider.readTranscript(result.sessionId, 50);
    expect(transcriptAfter.items.some(i => i.text.includes('[mock Muse]'))).toBe(true);
  });

  it('createSession with prompt session can be interrupted', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Long task',
    });
    
    expect(result.status).toBe('accepted');
    expect(provider.getSessionStatus(result.sessionId)).toBe('running');
    
    const interruptResult = await provider.interrupt(result.sessionId);
    
    expect(interruptResult.status).toBe('interrupted');
    expect(interruptResult.turnId).toBe(result.turnId);
    expect(provider.getSessionStatus(result.sessionId)).toBe('idle');
  });
});

describe('MuseProvider mock mode - wait_turn', () => {
  beforeEach(() => {
    vi.stubEnv('MUSE_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('waitTurn returns completed after turn finishes', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Test wait turn',
    });
    
    expect(result.status).toBe('accepted');
    expect(result.turnId).toBeDefined();
    
    const waitResult = await provider.waitTurn(result.sessionId, {
      timeoutMs: 2000,
      pollIntervalMs: 30,
    });
    
    expect(waitResult.sessionId).toBe(result.sessionId);
    expect(waitResult.status).toBe('completed');
    expect(waitResult.latestMessage).toBeDefined();
    expect(waitResult.latestMessage).toMatch(/mock Muse/i);
  });

  it('waitTurn returns idle when no active turn', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    expect(result.status).toBe('created');
    
    const waitResult = await provider.waitTurn(result.sessionId);
    
    expect(waitResult.sessionId).toBe(result.sessionId);
    expect(waitResult.status).toBe('idle');
  });

  it('waitTurn returns timeout when turn takes too long', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Start task',
    });
    
    const waitResult = await provider.waitTurn(result.sessionId, {
      timeoutMs: 10,
      pollIntervalMs: 5,
    });
    
    expect(['timeout', 'completed']).toContain(waitResult.status);
    expect(waitResult.sessionId).toBe(result.sessionId);
    expect(waitResult.turnId).toBeDefined();
  });

  it('waitTurn respects custom timeout and poll interval', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Test custom timeout',
    });
    
    const startTime = Date.now();
    const waitResult = await provider.waitTurn(result.sessionId, {
      timeoutMs: 200,
      pollIntervalMs: 10,
    });
    const elapsed = Date.now() - startTime;
    
    expect(waitResult.status).toBe('completed');
    expect(elapsed).toBeLessThan(500);
  });

  it('waitTurn returns latest assistant message snippet', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });
    
    await provider.waitTurn(result.sessionId, {
      timeoutMs: 200,
      pollIntervalMs: 10,
    });
    
    const sendResult = await provider.sendMessage(result.sessionId, 'Second message');
    
    const waitResult = await provider.waitTurn(result.sessionId, {
      timeoutMs: 200,
      pollIntervalMs: 10,
    });
    
    expect(waitResult.status).toBe('completed');
    expect(waitResult.turnId).toBe(sendResult.turnId);
    expect(waitResult.latestMessage).toMatch(/mock Muse.*Second message/i);
  });

  it('waitTurn throws for unknown session', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.waitTurn('nonexistent')).rejects.toThrow(/unknown mock session/i);
  });

  it('steer returns unsupported error for Muse', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Test steer',
    });
    
    const steerResult = await provider.steer(result.sessionId, 'guidance');
    
    expect(steerResult.sessionId).toBe(result.sessionId);
    expect(steerResult.accepted).toBe(false);
    expect(steerResult.error).toMatch(/muse does not support mid-turn steering/i);
    expect(steerResult.error).toMatch(/interrupt/i);
  });

  it('listApprovals returns empty array for Muse', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    const approvalsResult = await provider.listApprovals(result.sessionId);
    
    expect(approvalsResult.sessionId).toBe(result.sessionId);
    expect(approvalsResult.approvals).toEqual([]);
  });

  it('resolveApproval returns unsupported error for Muse', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    const resolveResult = await provider.resolveApproval(
      result.sessionId,
      'any_approval_id',
      'accept',
    );
    
    expect(resolveResult.sessionId).toBe(result.sessionId);
    expect(resolveResult.approvalId).toBe('any_approval_id');
    expect(resolveResult.resolved).toBe(false);
    expect(resolveResult.error).toMatch(/muse does not support programmatic approval/i);
    expect(resolveResult.error).toMatch(/local muse session/i);
  });
});

describe('MuseProvider mock mode - session metadata', () => {
  beforeEach(() => {
    vi.stubEnv('MUSE_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('createSession with name and tags', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      name: 'My Muse Session',
      tags: ['test', 'demo'],
    });
    
    const session = await provider.getSession(result.sessionId);
    expect(session?.name).toBe('My Muse Session');
    expect(session?.tags).toEqual(['test', 'demo']);
  });

  it('setSessionMeta updates name and tags', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      name: 'Original Name',
    });
    
    const updateResult = await provider.setSessionMeta(result.sessionId, {
      name: 'Updated Name',
      tags: ['new', 'tags'],
    });
    
    expect(updateResult.updated).toBe(true);
    expect(updateResult.name).toBe('Updated Name');
    expect(updateResult.tags).toEqual(['new', 'tags']);
    
    const session = await provider.getSession(result.sessionId);
    expect(session?.name).toBe('Updated Name');
    expect(session?.tags).toEqual(['new', 'tags']);
  });

  it('setSessionMeta returns error for unknown session', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    const result = await provider.setSessionMeta('nonexistent', {
      name: 'Test',
    });
    
    expect(result.updated).toBe(false);
    expect(result.error).toMatch(/session not found/i);
  });
});

describe('MuseProvider real mode (MUSE_MOCK unset) - requires mock', () => {
  beforeEach(() => {
    vi.stubEnv('MUSE_MOCK', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const EXPECTED_ERROR = /muse provider requires muse_mock=1/i;

  it('listSessions throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.listSessions()).rejects.toThrow(EXPECTED_ERROR);
  });

  it('createSession throws clear error in real mode (no ghost sessions)', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.createSession({ cwd: '/tmp/test' })).rejects.toThrow(EXPECTED_ERROR);
  });

  it('getSession throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.getSession('any-session')).rejects.toThrow(EXPECTED_ERROR);
  });

  it('sendMessage throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.sendMessage('any-session', 'hello')).rejects.toThrow(EXPECTED_ERROR);
  });

  it('readTranscript throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.readTranscript('any-session')).rejects.toThrow(EXPECTED_ERROR);
  });

  it('interrupt throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.interrupt('any-session')).rejects.toThrow(EXPECTED_ERROR);
  });

  it('waitTurn throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.waitTurn('any-session')).rejects.toThrow(EXPECTED_ERROR);
  });

  it('setSessionMeta throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.setSessionMeta('any-session', { name: 'test' })).rejects.toThrow(EXPECTED_ERROR);
  });

  it('steer throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.steer('any-session', 'guidance')).rejects.toThrow(EXPECTED_ERROR);
  });

  it('listApprovals throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.listApprovals('any-session')).rejects.toThrow(EXPECTED_ERROR);
  });

  it('resolveApproval throws clear error in real mode', async () => {
    const { MuseProvider } = await import('../src/providers/muse.js');
    const provider = new MuseProvider();
    
    await expect(provider.resolveApproval('any-session', 'any-approval', 'accept')).rejects.toThrow(EXPECTED_ERROR);
  });
});
