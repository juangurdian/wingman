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
});
