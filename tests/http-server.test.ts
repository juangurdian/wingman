/**
 * End-to-end tests over real HTTP: bearer auth, tool registration, and the
 * MCP SDK's input validation. Handler-level tests in tools.test.ts cannot catch
 * a registered inputSchema that rejects arguments the handler supports.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:net';

const TOKEN = 'test-token-123';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe('MCP server over HTTP (mock providers)', () => {
  let url: string;
  let close: () => Promise<void>;
  let nextId = 1;

  async function rpc(method: string, params: unknown, token: string | null = TOKEN) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    const body = await res.text();
    if (!res.ok) return { status: res.status, body };
    // Streamable HTTP answers with an SSE frame: "event: message\ndata: {...}"
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
    return { status: res.status, message: JSON.parse(dataLine ? dataLine.slice(6) : body) };
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const { message } = await rpc('tools/call', { name, arguments: args });
    const result = message.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? '';
    if (result.isError) return { isError: true, text };
    return { isError: false, text, data: JSON.parse(text) };
  }

  beforeAll(async () => {
    vi.stubEnv('CODEX_MOCK', '1');
    vi.stubEnv('CLAUDE_MOCK', '1');
    vi.stubEnv('MUSE_MOCK', '1');
    const { startMcpServer } = await import('../src/mcp/server.js');
    const server = await startMcpServer({
      host: '127.0.0.1',
      port: await freePort(),
      token: TOKEN,
      quiet: true,
    });
    url = server.url;
    close = server.close;
  });

  afterAll(async () => {
    await close?.();
    vi.unstubAllEnvs();
  });

  it('rejects requests without a bearer token', async () => {
    const res = await rpc('tools/list', {}, null);
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong bearer token', async () => {
    const res = await rpc('tools/list', {}, 'wrong-token');
    expect(res.status).toBe(403);
  });

  it('registers every tool with all providers allowed', async () => {
    const { message } = await rpc('tools/list', {});
    const tools = message.result.tools as { name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[];
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'create_session',
        'export_transcript',
        'get_session',
        'interrupt',
        'list_approvals',
        'list_sessions',
        'read_transcript',
        'resolve_approval',
        'send_message',
        'set_session_meta',
        'steer',
        'wait_turn',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.properties.provider?.enum).toEqual(['codex', 'claude', 'muse']);
    }
  });

  it('wait_turn accepts Claude sessions', async () => {
    const created = await callTool('create_session', { provider: 'claude', prompt: 'hello' });
    expect(created.isError).toBe(false);

    const waited = await callTool('wait_turn', {
      provider: 'claude',
      session_id: created.data.sessionId,
      timeout_ms: 2000,
      poll_interval_ms: 20,
    });
    expect(waited.isError).toBe(false);
    expect(waited.data.status).toBe('completed');
  });

  it('runs the Claude approval flow end to end', async () => {
    const created = await callTool('create_session', {
      provider: 'claude',
      prompt: 'sudo apt update',
    });
    const sessionId = created.data.sessionId as string;

    const blocked = await callTool('wait_turn', {
      provider: 'claude',
      session_id: sessionId,
      timeout_ms: 2000,
      poll_interval_ms: 20,
    });
    expect(blocked.data).toMatchObject({ status: 'inProgress', pendingApprovals: 1 });

    const listed = await callTool('list_approvals', { provider: 'claude', session_id: sessionId });
    const [approval] = listed.data.approvals;
    expect(approval).toMatchObject({ kind: 'command', command: 'sudo apt update' });

    const resolved = await callTool('resolve_approval', {
      provider: 'claude',
      session_id: sessionId,
      approval_id: approval.id,
      decision: 'accept',
    });
    expect(resolved.data.resolved).toBe(true);

    const done = await callTool('wait_turn', {
      provider: 'claude',
      session_id: sessionId,
      timeout_ms: 2000,
      poll_interval_ms: 20,
    });
    expect(done.data.status).toBe('completed');
    expect(done.data.latestMessage).toContain('Ran: sudo apt update');
  });

  it('reaches the Muse provider', async () => {
    const listed = await callTool('list_sessions', { provider: 'muse' });
    expect(listed.isError).toBe(false);
    expect(Array.isArray(listed.data.sessions)).toBe(true);
  });
});
