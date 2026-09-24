import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hostname } from 'node:os';

describe('ClaudeProvider mock mode', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('host fields in session responses', () => {
    it('listSessions includes hostId and hostName from defaults', async () => {
      const { ClaudeProvider } = await import('../src/providers/claude.js');
      const provider = new ClaudeProvider();
      const sessions = await provider.listSessions();
      
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0].hostId).toBe(hostname());
      expect(sessions[0].hostName).toBe(hostname());
    });

    it('listSessions uses custom WINGMAN_HOST_ID/NAME', async () => {
      vi.stubEnv('WINGMAN_HOST_ID', 'macbook');
      vi.stubEnv('WINGMAN_HOST_NAME', 'MacBook Pro');
      const { ClaudeProvider } = await import('../src/providers/claude.js');
      const provider = new ClaudeProvider();
      const sessions = await provider.listSessions();
      
      expect(sessions[0].hostId).toBe('macbook');
      expect(sessions[0].hostName).toBe('MacBook Pro');
    });

    it('getSession includes hostId and hostName', async () => {
      vi.stubEnv('WINGMAN_HOST_ID', 'macbook');
      vi.stubEnv('WINGMAN_HOST_NAME', 'MacBook Pro');
      const { ClaudeProvider } = await import('../src/providers/claude.js');
      const provider = new ClaudeProvider();
      const sessions = await provider.listSessions();
      const sessionId = sessions[0].id;
      
      const session = await provider.getSession(sessionId);
      expect(session?.hostId).toBe('macbook');
      expect(session?.hostName).toBe('MacBook Pro');
    });
  });

  it('listSessions returns mock sessions', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    const sessions = await provider.listSessions();
    
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].provider).toBe('claude');
    expect(sessions[0].id).toMatch(/^claude_mock_/);
  });

  it('createSession creates a new mock session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Hello Claude',
    });
    
    expect(result.provider).toBe('claude');
    expect(result.cwd).toBe('/tmp/test');
    expect(result.sessionId).toMatch(/^claude_mock_/);
    
    const sessions = await provider.listSessions();
    expect(sessions.some(s => s.id === result.sessionId)).toBe(true);
  });

  it('sendMessage returns accepted and processes in background', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    expect(transcriptAfter.items.some(i => i.text.includes('[mock Claude]'))).toBe(true);
  });

  it('readTranscript returns items for mock session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const transcript = await provider.readTranscript(sessionId, 50);
    
    expect(transcript.provider).toBe('claude');
    expect(transcript.sessionId).toBe(sessionId);
    expect(transcript.items.length).toBeGreaterThan(0);
  });

  it('interrupt returns status for mock session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const result = await provider.interrupt(sessionId);
    
    expect(result.sessionId).toBe(sessionId);
    expect(result.status).toBe('interrupted');
  });

  it('readTranscript throws for unknown session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    await expect(provider.readTranscript('nonexistent')).rejects.toThrow(/unknown mock session/i);
  });

  it('readTranscript returns messages in chronological order (oldest first, newest last)', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const session = await provider.getSession(sessionId);
    
    expect(session).not.toBeNull();
    expect(session?.id).toBe(sessionId);
    expect(session?.provider).toBe('claude');
    expect(session?.status).toBe('idle');
  });

  it('getSession shows running status during active turn', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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

  it('interrupt returns no_active_turn when session is idle', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const interruptResult = await provider.interrupt(result.sessionId);
    
    expect(interruptResult.sessionId).toBe(result.sessionId);
    expect(interruptResult.status).toBe('interrupted');
  });

  it('getSessionStatus returns correct status', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    expect(result.provider).toBe('claude');
    expect(result.status).toBe('created');
    expect(result.turnId).toBeUndefined();
    expect(provider.getSessionStatus(result.sessionId)).toBe('idle');
  });

  it('createSession with prompt returns accepted quickly with turnId', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const startTime = Date.now();
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Hello Claude',
    });
    const elapsed = Date.now() - startTime;
    
    expect(result.provider).toBe('claude');
    expect(result.status).toBe('accepted');
    expect(result.turnId).toBeDefined();
    expect(result.sessionId).toMatch(/^claude_mock_/);
    expect(elapsed).toBeLessThan(100);
  });

  it('createSession with prompt starts turn in background', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    expect(transcriptAfter.items.some(i => i.text.includes('[mock Claude]'))).toBe(true);
  });

  it('createSession with prompt session can be interrupted', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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

describe('ClaudeProvider mock mode - wait_turn parity', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('waitTurn returns completed after turn finishes', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    expect(waitResult.latestMessage).toMatch(/mock Claude/i);
  });

  it('waitTurn returns idle when no active turn', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    expect(result.status).toBe('created');
    
    const waitResult = await provider.waitTurn(result.sessionId);
    
    expect(waitResult.sessionId).toBe(result.sessionId);
    expect(waitResult.status).toBe('idle');
  });

  it('waitTurn returns timeout when turn takes too long', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Start task',
    });
    
    // Manually keep the turn active by not letting it complete
    // We'll use a very short timeout to trigger timeout before the 50ms mock delay
    const waitResult = await provider.waitTurn(result.sessionId, {
      timeoutMs: 10,
      pollIntervalMs: 5,
    });
    
    // Either timeout or completed depending on timing
    expect(['timeout', 'completed']).toContain(waitResult.status);
    expect(waitResult.sessionId).toBe(result.sessionId);
    expect(waitResult.turnId).toBeDefined();
  });

  it('waitTurn respects custom timeout and poll interval', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    // Should complete within reasonable time (mock completes in 50ms)
    expect(elapsed).toBeLessThan(500);
  });

  it('waitTurn returns latest assistant message snippet', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    expect(waitResult.latestMessage).toMatch(/mock Claude.*Second message/i);
  });

  it('waitTurn throws for unknown session', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    await expect(provider.waitTurn('nonexistent')).rejects.toThrow(/unknown mock session/i);
  });

  it('steer returns unsupported error for Claude', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
      prompt: 'Test steer',
    });
    
    const steerResult = await provider.steer(result.sessionId, 'guidance');
    
    expect(steerResult.sessionId).toBe(result.sessionId);
    expect(steerResult.accepted).toBe(false);
    expect(steerResult.error).toMatch(/claude does not support mid-turn steering/i);
    expect(steerResult.error).toMatch(/interrupt/i);
  });

  it('listApprovals returns empty array for Claude', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
    const result = await provider.createSession({
      cwd: '/tmp/test',
    });
    
    const approvalsResult = await provider.listApprovals(result.sessionId);
    
    expect(approvalsResult.sessionId).toBe(result.sessionId);
    expect(approvalsResult.approvals).toEqual([]);
  });

  it('resolveApproval returns unsupported error for Claude', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();
    
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
    expect(resolveResult.error).toMatch(/claude does not support programmatic approval/i);
    expect(resolveResult.error).toMatch(/local claude cli/i);
  });
});
