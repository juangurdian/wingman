import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ClaudeProvider mock mode', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
});
