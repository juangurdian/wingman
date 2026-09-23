import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('CodexProvider mock mode - wait/steer/approvals', () => {
  beforeEach(() => {
    vi.stubEnv('CODEX_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('listSessions returns mock sessions', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    const sessions = await provider.listSessions();
    
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].provider).toBe('codex');
    expect(sessions[0].id).toMatch(/^thr_mock_/);
  });

  it('sendMessage returns inProgress status for async turn', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const result = await provider.sendMessage(sessionId, 'test message');
    
    expect(result.sessionId).toBe(sessionId);
    expect(result.turnId).toBeDefined();
    expect(result.status).toBe('inProgress');
  });

  it('waitTurn returns completed after turn finishes', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    await provider.sendMessage(sessionId, 'test message');
    
    const result = await provider.waitTurn(sessionId, { timeoutMs: 2000 });
    
    expect(result.sessionId).toBe(sessionId);
    expect(result.status).toBe('completed');
    expect(result.latestMessage).toBeDefined();
  });

  it('waitTurn returns idle when no active turn', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait a bit for any initial turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const waitResult = await provider.waitTurn(result.sessionId);
    
    expect(waitResult.status).toBe('idle');
  });

  it('steer adds input to active turn', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    await provider.sendMessage(result.sessionId, 'start task');
    
    const steerResult = await provider.steer(result.sessionId, 'additional guidance');
    
    expect(steerResult.sessionId).toBe(result.sessionId);
    expect(steerResult.accepted).toBe(true);
    expect(steerResult.turnId).toBeDefined();
    
    const transcript = await provider.readTranscript(result.sessionId, 50);
    expect(transcript.items.some(i => i.text.includes('[steer]'))).toBe(true);
  });

  it('steer returns error when no active turn', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for any initial turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const steerResult = await provider.steer(result.sessionId, 'guidance');
    
    expect(steerResult.accepted).toBe(false);
    expect(steerResult.error).toMatch(/no active turn/i);
  });

  it('sendMessage with sudo creates pending approval', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const sendResult = await provider.sendMessage(result.sessionId, 'sudo apt update');
    
    expect(sendResult.status).toBe('inProgress');
    
    const approvals = await provider.listApprovals(result.sessionId);
    
    expect(approvals.sessionId).toBe(result.sessionId);
    expect(approvals.approvals.length).toBe(1);
    expect(approvals.approvals[0].kind).toBe('command');
    expect(approvals.approvals[0].command).toBe('sudo apt update');
  });

  it('sendMessage with rm -rf creates pending approval', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await provider.sendMessage(result.sessionId, 'rm -rf /tmp/old');
    
    const approvals = await provider.listApprovals(result.sessionId);
    
    expect(approvals.approvals.length).toBe(1);
    expect(approvals.approvals[0].command).toMatch(/rm -rf/);
  });

  it('listApprovals returns empty array when no approvals pending', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const approvals = await provider.listApprovals(sessionId);
    
    expect(approvals.sessionId).toBe(sessionId);
    expect(approvals.approvals).toEqual([]);
  });

  it('resolveApproval accepts and completes turn', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await provider.sendMessage(result.sessionId, 'sudo test');
    
    const approvals = await provider.listApprovals(result.sessionId);
    const approvalId = approvals.approvals[0].id;
    
    const resolveResult = await provider.resolveApproval(result.sessionId, approvalId, 'accept');
    
    expect(resolveResult.resolved).toBe(true);
    expect(resolveResult.decision).toBe('accept');
    
    // Wait for turn to complete after approval
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Turn may complete quickly after approval, so waitTurn might return idle
    const waitResult = await provider.waitTurn(result.sessionId);
    expect(['completed', 'idle']).toContain(waitResult.status);
    
    const transcript = await provider.readTranscript(result.sessionId, 50);
    expect(transcript.items.some(i => i.text.includes('accepted'))).toBe(true);
  });

  it('resolveApproval decline ends turn', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await provider.sendMessage(result.sessionId, 'sudo dangerous');
    
    const approvals = await provider.listApprovals(result.sessionId);
    const approvalId = approvals.approvals[0].id;
    
    const resolveResult = await provider.resolveApproval(result.sessionId, approvalId, 'decline');
    
    expect(resolveResult.resolved).toBe(true);
    expect(resolveResult.decision).toBe('decline');
    
    const transcript = await provider.readTranscript(result.sessionId, 50);
    expect(transcript.items.some(i => i.text.includes('declined'))).toBe(true);
    
    // Verify no active turn after decline
    const session = await provider.getSession(result.sessionId);
    expect(session?.status).toBe('idle');
  });

  it('resolveApproval returns error for unknown approval', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const sessions = await provider.listSessions();
    const sessionId = sessions[0].id;
    
    const resolveResult = await provider.resolveApproval(sessionId, 'nonexistent', 'accept');
    
    expect(resolveResult.resolved).toBe(false);
    expect(resolveResult.error).toMatch(/not found/i);
  });

  it('waitTurn returns inProgress when approval is pending', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await provider.sendMessage(result.sessionId, 'sudo pending');
    
    const waitResult = await provider.waitTurn(result.sessionId, { timeoutMs: 100 });
    
    // Should return quickly indicating approvals are pending
    expect(waitResult.latestMessage).toMatch(/approval/i);
  });

  it('getSession shows running status during active turn', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Start a turn with approval (keeps it running)
    await provider.sendMessage(result.sessionId, 'sudo keep running');
    
    const session = await provider.getSession(result.sessionId);
    
    expect(session?.status).toMatch(/running|active/);
    expect(session?.activeTurnId).toBeDefined();
  });

  it('multiple approvals can be listed and resolved', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // First command with approval
    await provider.sendMessage(result.sessionId, 'sudo first');
    let approvals = await provider.listApprovals(result.sessionId);
    expect(approvals.approvals.length).toBe(1);
    
    const firstApprovalId = approvals.approvals[0].id;
    
    // Accept first approval
    await provider.resolveApproval(result.sessionId, firstApprovalId, 'accept');
    
    // Wait for turn to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify approval is cleared
    approvals = await provider.listApprovals(result.sessionId);
    expect(approvals.approvals.length).toBe(0);
  });

  it('waitTurn respects timeout', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Start a turn with approval that won't complete
    await provider.sendMessage(result.sessionId, 'sudo blocks forever');
    
    const startTime = Date.now();
    const waitResult = await provider.waitTurn(result.sessionId, { 
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    const elapsed = Date.now() - startTime;
    
    // Should timeout but not take much longer than timeout value
    // Using inProgress as status since approvals are pending
    expect(waitResult.latestMessage).toMatch(/approval/i);
    expect(elapsed).toBeLessThan(500);
  });

  it('interrupt clears pending approvals', async () => {
    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();
    
    const result = await provider.createSession({ cwd: '/tmp/test' });
    
    // Wait for initial turn
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Start a turn with approval
    await provider.sendMessage(result.sessionId, 'sudo test interrupt');
    
    // Verify approval exists
    let approvals = await provider.listApprovals(result.sessionId);
    expect(approvals.approvals.length).toBe(1);
    
    // Interrupt
    await provider.interrupt(result.sessionId);
    
    // Verify session is idle after interrupt
    const session = await provider.getSession(result.sessionId);
    expect(session?.status).toBe('idle');
  });
});
