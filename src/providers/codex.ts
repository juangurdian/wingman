/**
 * Codex app-server client (JSON-RPC over stdio).
 *
 * Docs:
 * - https://learn.chatgpt.com/docs/app-server
 * - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 *
 * Methods used (v2):
 * - initialize / initialized
 * - thread/list, thread/start, thread/resume, thread/read
 * - turn/start, turn/interrupt
 *
 * Do NOT use removed/legacy `codex mcp-server` for this bridge.
 * Set CODEX_MOCK=1 for in-memory mock mode (no codex binary required).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type {
  CreateSessionResult,
  InterruptResult,
  SendMessageResult,
  SessionProvider,
  SessionSummary,
  Transcript,
  TranscriptItem,
} from './types.js';

type JsonRpcId = number;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

interface MockSession {
  id: string;
  cwd?: string;
  name?: string;
  preview?: string;
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  activeTurnId?: string;
}

function useMock(): boolean {
  return process.env.CODEX_MOCK === '1' || process.env.CODEX_MOCK === 'true';
}

export class CodexProvider implements SessionProvider {
  readonly name = 'codex' as const;
  private mockSessions = new Map<string, MockSession>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private activeTurns = new Map<string, string>(); // threadId -> turnId
  private ready: Promise<void> | null = null;

  constructor() {
    if (useMock()) {
      // Seed a couple of mock sessions for easy pair demos.
      const a = this.seedMock({ cwd: process.cwd(), name: 'mock-demo', preview: 'Hello from mock Codex' });
      a.items.push(
        { role: 'user', text: 'Hello from mock Codex', turnId: 'turn_mock_1' },
        { role: 'assistant', text: 'Mock Codex ready. Set CODEX_MOCK=0 and install `codex` for real mode.', turnId: 'turn_mock_1' },
      );
    }
  }

  private seedMock(opts?: { cwd?: string; name?: string; preview?: string }): MockSession {
    const now = Date.now();
    const s: MockSession = {
      id: `thr_mock_${randomUUID().slice(0, 8)}`,
      cwd: opts?.cwd,
      name: opts?.name,
      preview: opts?.preview,
      createdAt: now,
      updatedAt: now,
      items: [],
    };
    this.mockSessions.set(s.id, s);
    return s;
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (useMock()) {
      return [...this.mockSessions.values()].map((s) => ({
        id: s.id,
        provider: 'codex',
        cwd: s.cwd,
        name: s.name,
        preview: s.preview,
        status: s.activeTurnId ? 'active' : 'idle',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    }

    await this.ensureConnected();
    const result = (await this.request('thread/list', {
      cursor: null,
      limit: 50,
      sortKey: 'updated_at',
    })) as { data?: Array<Record<string, unknown>> };

    return (result.data ?? []).map((t) => ({
      id: String(t.id ?? ''),
      provider: 'codex' as const,
      cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
      name: typeof t.name === 'string' ? t.name : undefined,
      preview: typeof t.preview === 'string' ? t.preview : undefined,
      status: summarizeStatus(t.status),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : undefined,
      updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : undefined,
    }));
  }

  async readTranscript(sessionId: string, limit = 50): Promise<Transcript> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      const items = s.items.slice(-Math.max(1, limit));
      return { sessionId, provider: 'codex', items };
    }

    await this.ensureConnected();
    // Prefer resume so history is available; fall back to thread/read with includeTurns.
    let thread: Record<string, unknown>;
    try {
      const resumed = (await this.request('thread/resume', { threadId: sessionId })) as {
        thread?: Record<string, unknown>;
      };
      thread = resumed.thread ?? {};
    } catch {
      const read = (await this.request('thread/read', {
        threadId: sessionId,
        includeTurns: true,
      })) as { thread?: Record<string, unknown> };
      thread = read.thread ?? {};
    }

    const items = extractTranscriptItems(thread).slice(-Math.max(1, limit));
    return { sessionId, provider: 'codex', items };
  }

  async sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      const turnId = `turn_mock_${randomUUID().slice(0, 8)}`;
      s.activeTurnId = turnId;
      s.items.push({ role: 'user', text, turnId });
      s.items.push({
        role: 'assistant',
        text: `[mock] Received: ${text}`,
        turnId,
      });
      s.preview = text.slice(0, 80);
      s.updatedAt = Date.now();
      s.activeTurnId = undefined;
      return { sessionId, turnId, status: 'completed' };
    }

    await this.ensureConnected();
    // Ensure thread is loaded before turn/start.
    try {
      await this.request('thread/resume', { threadId: sessionId });
    } catch {
      // Thread may already be loaded; continue.
    }

    const result = (await this.request('turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text }],
    })) as { turn?: { id?: string; status?: string } };

    const turnId = result.turn?.id;
    if (turnId) this.activeTurns.set(sessionId, turnId);
    return {
      sessionId,
      turnId,
      status: result.turn?.status ?? 'inProgress',
    };
  }

  async interrupt(sessionId: string): Promise<InterruptResult> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      const turnId = s.activeTurnId;
      s.activeTurnId = undefined;
      s.items.push({
        role: 'system',
        text: '[mock] Interrupted',
        turnId,
      });
      return { sessionId, turnId, status: 'interrupted' };
    }

    await this.ensureConnected();
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) {
      // Best-effort: interrupt without a known turnId is not supported by protocol.
      // TODO: track turnId from turn/started notifications for accuracy.
      throw new Error(
        `No known active turnId for session ${sessionId}. ` +
          `Send a message first, or track turn/started notifications.`,
      );
    }

    await this.request('turn/interrupt', { threadId: sessionId, turnId });
    this.activeTurns.delete(sessionId);
    return { sessionId, turnId, status: 'interrupted' };
  }

  async createSession(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    if (useMock()) {
      const s = this.seedMock({
        cwd: opts?.cwd ?? process.cwd(),
        name: 'mock-created',
        preview: opts?.prompt?.slice(0, 80),
      });
      if (opts?.prompt) {
        await this.sendMessage(s.id, opts.prompt);
      }
      return { sessionId: s.id, provider: 'codex', cwd: s.cwd };
    }

    await this.ensureConnected();
    const params: Record<string, unknown> = {};
    if (opts?.cwd) params.cwd = opts.cwd;

    const result = (await this.request('thread/start', params)) as {
      thread?: { id?: string };
    };
    const sessionId = result.thread?.id;
    if (!sessionId) throw new Error('thread/start did not return thread.id');

    if (opts?.prompt) {
      await this.sendMessage(sessionId, opts.prompt);
    }

    return { sessionId, provider: 'codex', cwd: opts?.cwd };
  }

  async close(): Promise<void> {
    if (this.proc) {
      for (const [, p] of this.pending) {
        p.reject(new Error('Codex app-server closed'));
      }
      this.pending.clear();
      this.proc.kill();
      this.proc = null;
      this.ready = null;
    }
  }

  private ensureConnected(): Promise<void> {
    if (useMock()) return Promise.resolve();
    if (this.ready) return this.ready;
    this.ready = this.startProcess();
    return this.ready;
  }

  private async startProcess(): Promise<void> {
    // Prefer `codex app-server` (default stdio). See docs linked above.
    const bin = process.env.CODEX_BIN?.trim() || 'codex';
    const args = (process.env.CODEX_APP_SERVER_ARGS ?? 'app-server')
      .split(/\s+/)
      .filter(Boolean);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn Codex app-server (${bin} ${args.join(' ')}): ${(err as Error).message}. ` +
          `Install Codex CLI and ensure \`codex\` is on PATH, or set CODEX_MOCK=1.`,
      );
    }

    this.proc = child;

    child.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });

    child.on('close', (code) => {
      const err = new Error(`Codex app-server exited with code ${code}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));

    child.stderr.on('data', (buf: Buffer) => {
      const msg = buf.toString('utf8').trim();
      if (msg) console.error('[codex app-server]', msg);
    });

    // Handshake required before any other method.
    await this.request('initialize', {
      clientInfo: {
        name: 'session-bridge',
        title: 'Session Bridge',
        version: '0.1.0',
      },
    });
    this.notify('initialized', {});
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: JsonRpcId;
      result?: unknown;
      error?: { code?: number; message?: string };
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.error('[codex] non-JSON line:', trimmed.slice(0, 200));
      return;
    }

    // Track turn ids from notifications when present.
    if (msg.method === 'turn/started') {
      const params = msg.params as { turn?: { id?: string }; threadId?: string } | undefined;
      // Some builds nest threadId differently; best-effort.
      const turnId = params?.turn?.id;
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (threadId && turnId) this.activeTurns.set(threadId, turnId);
    }

    if (msg.id === undefined || msg.id === null) return; // notification
    const pending = this.pending.get(msg.id as JsonRpcId);
    if (!pending) return;
    this.pending.delete(msg.id as JsonRpcId);
    if (msg.error) {
      pending.reject(
        new Error(`Codex RPC error ${msg.error.code ?? '?'}: ${msg.error.message ?? 'unknown'}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = this.nextId++;
    const payload = { method, id, params: params ?? {} };
    // Wire format omits "jsonrpc":"2.0" per Codex docs.
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timeoutMs = Number(process.env.CODEX_RPC_TIMEOUT_MS ?? 60_000);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Codex RPC timeout after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs).unref?.();
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ method, params: params ?? {} })}\n`);
  }
}

function summarizeStatus(status: unknown): string | undefined {
  if (!status) return undefined;
  if (typeof status === 'string') return status;
  if (typeof status === 'object' && status !== null && 'type' in status) {
    return String((status as { type: unknown }).type);
  }
  return undefined;
}

function extractTranscriptItems(thread: Record<string, unknown>): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;
    const t = turn as { id?: string; items?: unknown[] };
    const turnItems = Array.isArray(t.items) ? t.items : [];
    for (const raw of turnItems) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const type = typeof item.type === 'string' ? item.type : 'unknown';
      const itemId = typeof item.id === 'string' ? item.id : undefined;
      if (type === 'userMessage') {
        items.push({
          role: 'user',
          text: contentToText(item.content) || String(item.text ?? ''),
          turnId: t.id,
          itemId,
          type,
        });
      } else if (type === 'agentMessage') {
        items.push({
          role: 'assistant',
          text: String(item.text ?? contentToText(item.content) ?? ''),
          turnId: t.id,
          itemId,
          type,
        });
      } else if (typeof item.text === 'string' && item.text) {
        items.push({
          role: 'unknown',
          text: item.text,
          turnId: t.id,
          itemId,
          type,
        });
      }
    }
  }
  return items;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const o = c as { type?: string; text?: string };
      if (o.type === 'text' || o.type === 'output_text') return o.text ?? '';
      return o.text ?? '';
    })
    .filter(Boolean)
    .join('\n');
}
