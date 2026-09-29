/**
 * Tests for Claude Code cross-session inbox functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('Claude Inbox - isWindowsNamedPipe', () => {
  it('recognizes Windows named pipe paths', async () => {
    const { isWindowsNamedPipe } = await import('../src/claude-inbox.js');
    
    // Valid Windows named pipe paths
    expect(isWindowsNamedPipe('\\\\.\\pipe\\LOCAL\\cc-msg-abc123')).toBe(true);
    expect(isWindowsNamedPipe('\\\\.\\pipe\\cc-msg-test')).toBe(true);
    expect(isWindowsNamedPipe('\\\\?\\pipe\\LOCAL\\cc-msg-xyz')).toBe(true);
    
    // Forward slashes (Node.js normalization)
    expect(isWindowsNamedPipe('//./pipe/LOCAL/cc-msg-abc123')).toBe(true);
    
    // Not named pipes
    expect(isWindowsNamedPipe('/tmp/cc-socks-1000/12345.sock')).toBe(false);
    expect(isWindowsNamedPipe('/var/run/socket.sock')).toBe(false);
    expect(isWindowsNamedPipe('')).toBe(false);
  });
});

describe('Claude Inbox - parseClaudeAgentsOutput', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_INBOX_MOCK', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses valid JSON array of agents', async () => {
    const { parseClaudeAgentsOutput } = await import('../src/claude-inbox.js');
    
    const output = JSON.stringify([
      {
        id: 'sess_abc123',
        sessionId: 'sess_abc123',
        pid: 12345,
        name: 'Test Session',
        status: 'idle',
        waitingFor: null,
      },
      {
        id: 'sess_def456',
        pid: 67890,
        status: 'running',
      },
    ]);
    
    const result = parseClaudeAgentsOutput(output);
    
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'sess_abc123',
      sessionId: 'sess_abc123',
      pid: 12345,
      name: 'Test Session',
      status: 'idle',
      state: undefined,
      waitingFor: null,
    });
  });

  it('parses background sessions with state instead of status', async () => {
    const { parseClaudeAgentsOutput } = await import('../src/claude-inbox.js');
    
    const output = JSON.stringify([
      {
        id: 'bg_session',
        name: 'Background Task',
        state: 'running',
        // no pid for background sessions
      },
    ]);
    
    const result = parseClaudeAgentsOutput(output);
    
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe('running');
    expect(result[0].pid).toBeUndefined();
  });

  it('returns empty array for invalid JSON', async () => {
    const { parseClaudeAgentsOutput } = await import('../src/claude-inbox.js');
    
    expect(parseClaudeAgentsOutput('not json')).toEqual([]);
    expect(parseClaudeAgentsOutput('{}')).toEqual([]);
    expect(parseClaudeAgentsOutput('')).toEqual([]);
  });
});

describe('Claude Inbox - parseRegistryFile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses registry file with all fields', async () => {
    const { parseRegistryFile } = await import('../src/claude-inbox.js');
    
    const content = JSON.stringify({
      pid: 12345,
      sessionId: 'sess_abc123',
      cwd: '/home/user/project',
      startedAt: 1727500000000,
      procStart: 1727500000,
      version: '2.1.284',
      peerProtocol: 1,
      peerFeatures: ['notify_idle', 'artifact_yield'],
      kind: 'interactive',
      entrypoint: 'claude',
      pidDomain: 'win32:pearlwolf',
      messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-abc123def456',
      name: 'My Session',
      nameSource: 'user',
      nameSince: 1727500100000,
      status: 'idle',
      updatedAt: 1727500200000,
      statusUpdatedAt: 1727500200000,
    });
    
    const result = parseRegistryFile(content);
    
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(12345);
    expect(result!.sessionId).toBe('sess_abc123');
    expect(result!.kind).toBe('interactive');
    expect(result!.pidDomain).toBe('win32:pearlwolf');
    expect(result!.messagingSocketPath).toBe('\\\\.\\pipe\\LOCAL\\cc-msg-abc123def456');
    expect(result!.peerFeatures).toEqual(['notify_idle', 'artifact_yield']);
  });

  it('parses minimal registry file', async () => {
    const { parseRegistryFile } = await import('../src/claude-inbox.js');
    
    const content = JSON.stringify({
      pid: 99999,
      messagingSocketPath: '/tmp/test.sock',
    });
    
    const result = parseRegistryFile(content);
    
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(99999);
    expect(result!.messagingSocketPath).toBe('/tmp/test.sock');
  });

  it('returns null for invalid JSON', async () => {
    const { parseRegistryFile } = await import('../src/claude-inbox.js');
    
    expect(parseRegistryFile('not json')).toBeNull();
    expect(parseRegistryFile('')).toBeNull();
  });

  it('returns null for non-object JSON', async () => {
    const { parseRegistryFile } = await import('../src/claude-inbox.js');
    
    expect(parseRegistryFile('[]')).toBeNull();
    expect(parseRegistryFile('"string"')).toBeNull();
    expect(parseRegistryFile('null')).toBeNull();
  });
});

describe('Claude Inbox - parseKeyFile', () => {
  it('parses valid key file', async () => {
    const { parseKeyFile } = await import('../src/claude-inbox.js');
    
    const content = JSON.stringify({
      peerToken: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      procStartFt: 133123456789012345,
      pidDomain: 'win32:pearlwolf',
    });
    
    const result = parseKeyFile(content);
    
    expect(result).not.toBeNull();
    expect(result!.peerToken).toBe('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6');
    expect(result!.pidDomain).toBe('win32:pearlwolf');
  });

  it('returns null for invalid key file', async () => {
    const { parseKeyFile } = await import('../src/claude-inbox.js');
    
    expect(parseKeyFile('not json')).toBeNull();
    expect(parseKeyFile('[]')).toBeNull();
    expect(parseKeyFile('')).toBeNull();
  });
});

describe('Claude Inbox - findAuthToken', () => {
  let tempDir: string;
  
  beforeEach(() => {
    tempDir = join(tmpdir(), `claude-inbox-auth-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    vi.stubEnv('CLAUDE_SESSIONS_DIR', tempDir);
    vi.stubEnv('CLAUDE_INBOX_MOCK', '0');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('finds auth token from key file', async () => {
    const { findAuthToken } = await import('../src/claude-inbox.js');
    
    // Create key file: <pid>.<sha256hex>.key
    const keyContent = JSON.stringify({
      peerToken: 'test_token_32_characters_long_xx',
      procStartFt: 133123456789012345,
      pidDomain: 'linux:testhost',
    });
    writeFileSync(join(tempDir, '12345.abc123def456.key'), keyContent);
    
    const token = findAuthToken(12345);
    
    expect(token).toBe('test_token_32_characters_long_xx');
  });

  it('prefers CLAUDE_CODE_MESSAGING_TOKEN env var', async () => {
    vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', 'env_token_override');
    
    const { findAuthToken } = await import('../src/claude-inbox.js');
    
    // Create key file that should be ignored
    const keyContent = JSON.stringify({ peerToken: 'file_token' });
    writeFileSync(join(tempDir, '12345.abc123.key'), keyContent);
    
    const token = findAuthToken(12345);
    
    expect(token).toBe('env_token_override');
  });

  it('returns undefined when no key file exists', async () => {
    const { findAuthToken } = await import('../src/claude-inbox.js');
    
    const token = findAuthToken(99999);
    
    expect(token).toBeUndefined();
  });

  it('returns undefined for undefined pid', async () => {
    const { findAuthToken } = await import('../src/claude-inbox.js');
    
    const token = findAuthToken(undefined);
    
    expect(token).toBeUndefined();
  });
});

describe('Claude Inbox - scanRegistryFiles', () => {
  let tempDir: string;
  
  beforeEach(() => {
    tempDir = join(tmpdir(), `claude-inbox-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    vi.stubEnv('CLAUDE_SESSIONS_DIR', tempDir);
    vi.stubEnv('CLAUDE_INBOX_MOCK', '0');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('scans <pid>.json files in directory', async () => {
    const { scanRegistryFiles } = await import('../src/claude-inbox.js');
    
    // Create registry files named <pid>.json
    writeFileSync(
      join(tempDir, '12345.json'),
      JSON.stringify({
        pid: 12345,
        sessionId: 'sess_abc123',
        messagingSocketPath: '/tmp/abc.sock',
        name: 'Session A',
      }),
    );
    
    writeFileSync(
      join(tempDir, '67890.json'),
      JSON.stringify({
        pid: 67890,
        sessionId: 'sess_def456',
        messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-xyz',
      }),
    );
    
    const result = scanRegistryFiles();
    
    expect(result.size).toBe(2);
    expect(result.get('sess_abc123')).toBeDefined();
    expect(result.get('sess_abc123')!.name).toBe('Session A');
    expect(result.get('sess_def456')).toBeDefined();
    expect(result.get('sess_def456')!.pid).toBe(67890);
  });

  it('ignores .key files', async () => {
    const { scanRegistryFiles } = await import('../src/claude-inbox.js');
    
    writeFileSync(join(tempDir, '12345.json'), JSON.stringify({ pid: 12345, sessionId: 'valid' }));
    writeFileSync(join(tempDir, '12345.abc123.key'), JSON.stringify({ peerToken: 'secret' }));
    
    const result = scanRegistryFiles();
    
    expect(result.size).toBe(1);
    expect(result.get('valid')).toBeDefined();
  });

  it('ignores non-pid-named JSON files', async () => {
    const { scanRegistryFiles } = await import('../src/claude-inbox.js');
    
    writeFileSync(join(tempDir, '12345.json'), JSON.stringify({ pid: 12345, sessionId: 'valid' }));
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ setting: 'value' }));
    writeFileSync(join(tempDir, 'sess_abc.json'), JSON.stringify({ sessionId: 'abc' }));
    
    const result = scanRegistryFiles();
    
    expect(result.size).toBe(1);
  });

  it('returns empty map when directory does not exist', async () => {
    vi.stubEnv('CLAUDE_SESSIONS_DIR', '/nonexistent/path');
    
    const { scanRegistryFiles } = await import('../src/claude-inbox.js');
    const result = scanRegistryFiles();
    
    expect(result.size).toBe(0);
  });
});

describe('Claude Inbox - listClaudeLiveSessions (mock mode)', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_INBOX_MOCK', '1');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns mock sessions when set', async () => {
    const { listClaudeLiveSessions, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      {
        sessionId: 'mock_session_1',
        pid: 1000,
        name: 'Mock Session',
        status: 'idle',
        messagingSocketPath: '/tmp/mock.sock',
        socketExists: true,
        source: 'both',
      },
    ]);
    
    const result = await listClaudeLiveSessions();
    
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('mock_session_1');
    expect(result[0].socketExists).toBe(true);
    
    setMockLiveSessions([]);
  });
});

describe('Claude Inbox - resolveSessionTarget', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_INBOX_MOCK', '1');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves by exact sessionId', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'sess_abc', name: 'Test', source: 'agents' },
      { sessionId: 'sess_def', name: 'Other', source: 'agents' },
    ]);
    
    const result = await resolveSessionTarget('sess_abc');
    
    expect(result.session).not.toBeNull();
    expect(result.session!.sessionId).toBe('sess_abc');
    expect(result.error).toBeUndefined();
    
    setMockLiveSessions([]);
  });

  it('resolves by pid', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'sess_abc', pid: 12345, source: 'agents' },
    ]);
    
    const result = await resolveSessionTarget('12345');
    
    expect(result.session).not.toBeNull();
    expect(result.session!.pid).toBe(12345);
    
    setMockLiveSessions([]);
  });

  it('resolves by unique name substring', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'sess_abc', name: 'Refactor Auth Module', source: 'agents' },
      { sessionId: 'sess_def', name: 'Write Tests', source: 'agents' },
    ]);
    
    const result = await resolveSessionTarget('Auth');
    
    expect(result.session).not.toBeNull();
    expect(result.session!.sessionId).toBe('sess_abc');
    
    setMockLiveSessions([]);
  });

  it('returns error for ambiguous name match', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'sess_abc', name: 'Test Session 1', source: 'agents' },
      { sessionId: 'sess_def', name: 'Test Session 2', source: 'agents' },
    ]);
    
    const result = await resolveSessionTarget('Test');
    
    expect(result.session).toBeNull();
    expect(result.error).toMatch(/ambiguous/i);
    expect(result.matches).toHaveLength(2);
    
    setMockLiveSessions([]);
  });

  it('returns error for no match', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'sess_abc', name: 'Test', source: 'agents' },
    ]);
    
    const result = await resolveSessionTarget('nonexistent');
    
    expect(result.session).toBeNull();
    expect(result.error).toMatch(/no session found/i);
    
    setMockLiveSessions([]);
  });
});

describe('Claude Inbox - sendToClaudeSession (mock mode)', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_INBOX_MOCK', '1');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('delivers message to session with working socket', async () => {
    const { sendToClaudeSession, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      {
        sessionId: 'sess_abc',
        messagingSocketPath: '/tmp/test.sock',
        socketExists: true,
        source: 'both',
        live: true, // Must be live to deliver via inbox
      },
    ]);
    
    const result = await sendToClaudeSession('sess_abc', 'Hello, Claude!');
    
    expect(result.delivered).toBe(true);
    expect(result.sessionId).toBe('sess_abc');
    expect(result.socketPath).toBe('/tmp/test.sock');
    
    setMockLiveSessions([]);
  });

  it('delivers message to Windows named pipe session', async () => {
    const { sendToClaudeSession, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      {
        sessionId: 'sess_win',
        messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-abc123',
        socketExists: true,
        source: 'both',
        live: true, // Must be live to deliver via inbox
      },
    ]);
    
    const result = await sendToClaudeSession('sess_win', 'Hello from Windows!');
    
    expect(result.delivered).toBe(true);
    expect(result.socketPath).toBe('\\\\.\\pipe\\LOCAL\\cc-msg-abc123');
    
    setMockLiveSessions([]);
  });

  it('fails when socket does not exist (Unix)', async () => {
    const { sendToClaudeSession, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      {
        sessionId: 'sess_abc',
        messagingSocketPath: '/tmp/test.sock',
        socketExists: false,
        source: 'both',
        live: true, // Live session, but socket doesn't exist
      },
    ]);
    
    const result = await sendToClaudeSession('sess_abc', 'Hello!');
    
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/socket/i);
    
    setMockLiveSessions([]);
  });

  it('lists matches when target is ambiguous', async () => {
    const { sendToClaudeSession, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'sess_abc', name: 'Project A', pid: 1000, source: 'agents' },
      { sessionId: 'sess_def', name: 'Project B', pid: 2000, source: 'agents' },
    ]);
    
    const result = await sendToClaudeSession('Project', 'Hello!');
    
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/ambiguous/i);
    expect(result.error).toMatch(/sess_abc/);
    expect(result.error).toMatch(/sess_def/);
    
    setMockLiveSessions([]);
  });
});

describe('Claude Inbox - socket communication', () => {
  let server: Server | null = null;
  let socketPath: string;
  let receivedData: string[] = [];
  
  beforeEach(() => {
    vi.stubEnv('CLAUDE_INBOX_MOCK', '0');
    receivedData = [];
    socketPath = join(tmpdir(), `test-sock-${Date.now()}.sock`);
  });
  
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
    if (existsSync(socketPath)) {
      rmSync(socketPath, { force: true });
    }
  });

  it('sends auth and message over socket', async () => {
    // Create a test socket server that accepts connection and receives data
    server = createServer((socket) => {
      socket.on('data', (data) => {
        receivedData.push(data.toString());
        // Don't close immediately - let rejection timer pass
      });
    });
    
    await new Promise<void>((resolve) => {
      server!.listen(socketPath, () => resolve());
    });
    
    // Test sending via raw socket (not through sendToClaudeSession which needs mocking)
    const { createConnection } = await import('node:net');
    const client = createConnection(socketPath);
    
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        const authLine = JSON.stringify({ type: 'auth', token: 'test_token_123' });
        const msgLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello!' } });
        client.write(authLine + '\n' + msgLine + '\n');
        setTimeout(() => {
          client.end();
          resolve();
        }, 100);
      });
      client.on('error', reject);
    });
    
    expect(receivedData.length).toBeGreaterThan(0);
    const fullData = receivedData.join('');
    expect(fullData).toContain('auth');
    expect(fullData).toContain('test_token_123');
    expect(fullData).toContain('user');
    expect(fullData).toContain('Hello!');
  });

  it('detects EOF as rejection', async () => {
    // Server that closes immediately after receiving data (simulating auth rejection)
    server = createServer((socket) => {
      socket.on('data', () => {
        // Close immediately to simulate rejection
        socket.end();
      });
    });
    
    await new Promise<void>((resolve) => {
      server!.listen(socketPath, () => resolve());
    });
    
    const { createConnection } = await import('node:net');
    
    const result = await new Promise<string>((resolve) => {
      const client = createConnection(socketPath);
      let result = 'connected';
      
      client.on('connect', () => {
        client.write('{"type":"user","message":{"role":"user","content":"test"}}\n');
      });
      
      client.on('end', () => {
        result = 'EOF';
        resolve(result);
      });
      
      client.on('error', (err) => {
        result = `error:${err.message}`;
        resolve(result);
      });
      
      client.on('close', () => {
        if (result === 'connected') {
          result = 'closed';
          resolve(result);
        }
      });
    });
    
    expect(result).toBe('EOF');
  });

  it('handles connection timeout for missing socket', async () => {
    const { createConnection } = await import('node:net');
    const nonexistentPath = join(tmpdir(), `nonexistent-${Date.now()}.sock`);
    
    const startTime = Date.now();
    
    await new Promise<void>((resolve) => {
      const client = createConnection(nonexistentPath);
      
      client.on('error', () => {
        resolve();
      });
      
      client.on('connect', () => {
        client.end();
        resolve();
      });
    });
    
    const elapsed = Date.now() - startTime;
    // Should fail quickly (ENOENT), not timeout
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('Claude Inbox - wire format', () => {
  it('generates correct auth message format', () => {
    const auth = {
      type: 'auth',
      token: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    };
    
    const json = JSON.stringify(auth);
    const parsed = JSON.parse(json);
    
    expect(parsed.type).toBe('auth');
    expect(parsed.token).toHaveLength(32);
  });

  it('generates correct user message format', () => {
    const message = {
      type: 'user',
      message: { role: 'user', content: 'Hello, Claude!' },
    };
    
    const json = JSON.stringify(message);
    const parsed = JSON.parse(json);
    
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toBe('Hello, Claude!');
  });

  it('handles UTF-8 content including emoji and CJK', () => {
    const content = 'Hello 你好 🎉 café naïve';
    const message = {
      type: 'user',
      message: { role: 'user', content },
    };
    
    const json = JSON.stringify(message);
    const parsed = JSON.parse(json);
    
    expect(parsed.message.content).toBe(content);
    expect(parsed.message.content).toContain('你好');
    expect(parsed.message.content).toContain('🎉');
    expect(parsed.message.content).toContain('café');
  });

  it('handles multi-line content', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const message = {
      type: 'user',
      message: { role: 'user', content },
    };
    
    const json = JSON.stringify(message);
    expect(json).not.toContain('\n\n'); // Should be escaped
    
    const parsed = JSON.parse(json);
    expect(parsed.message.content).toBe(content);
    expect(parsed.message.content.split('\n')).toHaveLength(3);
  });
});

describe('Claude Inbox - Windows pipe path handling', () => {
  it('recognizes various Windows pipe path formats', async () => {
    const { isWindowsNamedPipe } = await import('../src/claude-inbox.js');
    
    // Standard format from live testing
    expect(isWindowsNamedPipe('\\\\.\\pipe\\LOCAL\\cc-msg-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6')).toBe(true);
    
    // Without LOCAL
    expect(isWindowsNamedPipe('\\\\.\\pipe\\cc-msg-test')).toBe(true);
    
    // With \\?\ prefix
    expect(isWindowsNamedPipe('\\\\?\\pipe\\LOCAL\\cc-msg-xyz')).toBe(true);
  });

  it('does not treat Unix paths as Windows pipes', async () => {
    const { isWindowsNamedPipe } = await import('../src/claude-inbox.js');
    
    expect(isWindowsNamedPipe('/tmp/socket.sock')).toBe(false);
    expect(isWindowsNamedPipe('/var/run/claude.sock')).toBe(false);
    expect(isWindowsNamedPipe('C:\\Users\\test\\socket')).toBe(false);
  });
});

describe('Claude Inbox - isPidRunning', () => {
  it('returns true for current process pid', async () => {
    const { isPidRunning } = await import('../src/claude-inbox.js');
    
    // Current process is always running
    expect(isPidRunning(process.pid)).toBe(true);
  });

  it('returns false for invalid pids', async () => {
    const { isPidRunning } = await import('../src/claude-inbox.js');
    
    expect(isPidRunning(0)).toBe(false);
    expect(isPidRunning(-1)).toBe(false);
    expect(isPidRunning(NaN)).toBe(false);
  });

  it('returns false for very high pid unlikely to exist', async () => {
    const { isPidRunning } = await import('../src/claude-inbox.js');
    
    // Very high pid unlikely to exist
    expect(isPidRunning(9999999)).toBe(false);
  });
});

describe('Claude Inbox - scanRegistryFilesWithLiveness', () => {
  let tempDir: string;
  
  beforeEach(() => {
    tempDir = join(tmpdir(), `claude-inbox-liveness-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    vi.stubEnv('CLAUDE_SESSIONS_DIR', tempDir);
    vi.stubEnv('CLAUDE_INBOX_MOCK', '0');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('marks session as live when pid is running', async () => {
    const { scanRegistryFilesWithLiveness } = await import('../src/claude-inbox.js');
    
    // Use current process pid (guaranteed to be running)
    const pid = process.pid;
    writeFileSync(
      join(tempDir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: 'live_session',
        messagingSocketPath: '/tmp/live.sock',
        status: 'idle',
      }),
    );
    
    const result = scanRegistryFilesWithLiveness();
    
    expect(result.size).toBe(1);
    const session = result.get('live_session');
    expect(session).toBeDefined();
    expect(session!.pidRunning).toBe(true);
  });

  it('marks session as not live when pid is not running', async () => {
    const { scanRegistryFilesWithLiveness } = await import('../src/claude-inbox.js');
    
    // Use a very high pid that's unlikely to exist
    const deadPid = 9999999;
    writeFileSync(
      join(tempDir, `${deadPid}.json`),
      JSON.stringify({
        pid: deadPid,
        sessionId: 'past_session',
        messagingSocketPath: '/tmp/past.sock',
      }),
    );
    
    const result = scanRegistryFilesWithLiveness();
    
    expect(result.size).toBe(1);
    const session = result.get('past_session');
    expect(session).toBeDefined();
    expect(session!.pidRunning).toBe(false);
  });
});

describe('Claude Inbox - name resolution with live preference', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_INBOX_MOCK', '1');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers live session when name matches both live and past', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'live_abc', name: 'Reddit agent', live: true, pid: 1000, source: 'both' },
      { sessionId: 'past_def', name: 'Reddit agent from 3 weeks ago', live: false, source: 'registry' },
    ]);
    
    const result = await resolveSessionTarget('Reddit');
    
    expect(result.session).not.toBeNull();
    expect(result.session!.sessionId).toBe('live_abc');
    expect(result.session!.live).toBe(true);
    expect(result.resolvedToPast).toBeFalsy();
    
    setMockLiveSessions([]);
  });

  it('returns ambiguity error when multiple live sessions match', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'live_1', name: 'Reddit agent core', live: true, pid: 1000, source: 'both' },
      { sessionId: 'live_2', name: 'Reddit agent growth', live: true, pid: 2000, source: 'both' },
      { sessionId: 'past_3', name: 'Reddit agent old', live: false, source: 'registry' },
    ]);
    
    const result = await resolveSessionTarget('Reddit');
    
    expect(result.session).toBeNull();
    expect(result.error).toMatch(/ambiguous.*2 live sessions/i);
    expect(result.matches).toHaveLength(2);
    // Should only list live matches
    expect(result.matches!.every(m => m.live)).toBe(true);
    
    setMockLiveSessions([]);
  });

  it('falls back to past sessions when no live match', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'live_abc', name: 'Active Project', live: true, source: 'both' },
      { sessionId: 'past_def', name: 'Reddit agent', live: false, source: 'registry' },
    ]);
    
    const result = await resolveSessionTarget('Reddit');
    
    expect(result.session).not.toBeNull();
    expect(result.session!.sessionId).toBe('past_def');
    expect(result.resolvedToPast).toBe(true);
    
    setMockLiveSessions([]);
  });

  it('returns ambiguity error for multiple past sessions (no live match)', async () => {
    const { resolveSessionTarget, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'past_1', name: 'Reddit agent v1', live: false, source: 'registry' },
      { sessionId: 'past_2', name: 'Reddit agent v2', live: false, source: 'registry' },
    ]);
    
    const result = await resolveSessionTarget('Reddit');
    
    expect(result.session).toBeNull();
    expect(result.error).toMatch(/ambiguous.*2 past sessions/i);
    expect(result.resolvedToPast).toBe(true);
    
    setMockLiveSessions([]);
  });
});

describe('Claude Inbox - sendToClaudeSession with past sessions', () => {
  beforeEach(() => {
    vi.stubEnv('CLAUDE_INBOX_MOCK', '1');
  });
  
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns error for past session suggesting SDK resume', async () => {
    const { sendToClaudeSession, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      { sessionId: 'past_session', name: 'Old Session', live: false, pid: 99999, source: 'registry' },
    ]);
    
    const result = await sendToClaudeSession('past_session', 'Hello');
    
    expect(result.delivered).toBe(false);
    expect(result.live).toBe(false);
    expect(result.method).toBe('past_session');
    expect(result.error).toMatch(/past session.*SDK/i);
    
    setMockLiveSessions([]);
  });

  it('delivers to live session via inbox', async () => {
    const { sendToClaudeSession, setMockLiveSessions } = await import('../src/claude-inbox.js');
    
    setMockLiveSessions([
      {
        sessionId: 'live_session',
        name: 'Active Session',
        live: true,
        messagingSocketPath: '/tmp/mock.sock',
        socketExists: true,
        source: 'both',
      },
    ]);
    
    const result = await sendToClaudeSession('live_session', 'Hello');
    
    expect(result.delivered).toBe(true);
    expect(result.live).toBe(true);
    expect(result.method).toBe('inbox');
    
    setMockLiveSessions([]);
  });
});
