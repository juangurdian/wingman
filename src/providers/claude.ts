/**
 * Claude Code provider using the official Agent SDK.
 *
 * This provider manages sessions that Wingman creates and controls, not
 * arbitrary Claude TTYs. Sessions are persisted locally by the SDK
 * (default: ~/.claude/projects/) and tracked by Wingman in a registry.
 *
 * Docs: https://code.claude.com/docs/en/agent-sdk/typescript
 *
 * Set CLAUDE_MOCK=1 for in-memory mock mode (no claude binary required).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

type QueryType = typeof import('@anthropic-ai/claude-agent-sdk').query;
type ListSessionsType = typeof import('@anthropic-ai/claude-agent-sdk').listSessions;
type GetSessionMessagesType = typeof import('@anthropic-ai/claude-agent-sdk').getSessionMessages;
type Query = ReturnType<QueryType>;

interface WingmanClaudeSession {
  sessionId: string;
  cwd: string;
  name?: string;
  preview?: string;
  createdAt: number;
  updatedAt: number;
}

interface MockSession extends WingmanClaudeSession {
  items: TranscriptItem[];
  activeTurnId?: string;
}

interface SessionRegistry {
  sessions: WingmanClaudeSession[];
}

function useMock(): boolean {
  return process.env.CLAUDE_MOCK === '1' || process.env.CLAUDE_MOCK === 'true';
}

function registryPath(): string {
  return join(homedir(), '.wingman', 'claude-sessions.json');
}

function loadRegistry(): SessionRegistry {
  const path = registryPath();
  if (!existsSync(path)) return { sessions: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionRegistry;
  } catch {
    return { sessions: [] };
  }
}

function saveRegistry(registry: SessionRegistry): void {
  const dir = join(homedir(), '.wingman');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function registerSession(session: WingmanClaudeSession): void {
  const registry = loadRegistry();
  const idx = registry.sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx >= 0) {
    registry.sessions[idx] = session;
  } else {
    registry.sessions.push(session);
  }
  saveRegistry(registry);
}

function updateSessionTimestamp(sessionId: string): void {
  const registry = loadRegistry();
  const session = registry.sessions.find((s) => s.sessionId === sessionId);
  if (session) {
    session.updatedAt = Date.now();
    saveRegistry(registry);
  }
}

export class ClaudeProvider implements SessionProvider {
  readonly name = 'claude' as const;

  private mockSessions = new Map<string, MockSession>();
  private activeQueries = new Map<string, Query>();
  private sdkImported: Promise<{
    query: QueryType;
    listSessions: ListSessionsType;
    getSessionMessages: GetSessionMessagesType;
  }> | null = null;

  constructor() {
    if (useMock()) {
      const s = this.seedMock({ cwd: process.cwd(), name: 'mock-claude-demo' });
      s.items.push(
        { role: 'user', text: 'Hello from mock Claude', turnId: 'turn_mock_1' },
        {
          role: 'assistant',
          text: 'Mock Claude ready. Set CLAUDE_MOCK=0 and install Claude Code for real mode.',
          turnId: 'turn_mock_1',
        },
      );
      s.preview = 'Hello from mock Claude';
    }
  }

  private seedMock(opts?: { cwd?: string; name?: string; preview?: string }): MockSession {
    const now = Date.now();
    const s: MockSession = {
      sessionId: `claude_mock_${randomUUID().slice(0, 8)}`,
      cwd: opts?.cwd ?? process.cwd(),
      name: opts?.name,
      preview: opts?.preview,
      createdAt: now,
      updatedAt: now,
      items: [],
    };
    this.mockSessions.set(s.sessionId, s);
    return s;
  }

  private async importSdk() {
    if (this.sdkImported) return this.sdkImported;
    this.sdkImported = import('@anthropic-ai/claude-agent-sdk').then((sdk) => ({
      query: sdk.query,
      listSessions: sdk.listSessions,
      getSessionMessages: sdk.getSessionMessages,
    }));
    return this.sdkImported;
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (useMock()) {
      return [...this.mockSessions.values()].map((s) => ({
        id: s.sessionId,
        provider: 'claude' as const,
        cwd: s.cwd,
        name: s.name,
        preview: s.preview,
        status: s.activeTurnId ? 'active' : 'idle',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    }

    const registry = loadRegistry();
    const sdk = await this.importSdk();

    const sessions: SessionSummary[] = [];
    for (const reg of registry.sessions) {
      try {
        const sdkSessions = await sdk.listSessions({ dir: reg.cwd, limit: 50 });
        const found = sdkSessions.find((s) => s.sessionId === reg.sessionId);
        if (found) {
          sessions.push({
            id: found.sessionId,
            provider: 'claude',
            cwd: found.cwd ?? reg.cwd,
            name: found.customTitle ?? reg.name,
            preview: found.firstPrompt ?? reg.preview,
            status: 'idle',
            createdAt: found.createdAt ?? reg.createdAt,
            updatedAt: found.lastModified ?? reg.updatedAt,
          });
        } else {
          sessions.push({
            id: reg.sessionId,
            provider: 'claude',
            cwd: reg.cwd,
            name: reg.name,
            preview: reg.preview,
            status: 'unknown',
            createdAt: reg.createdAt,
            updatedAt: reg.updatedAt,
          });
        }
      } catch {
        sessions.push({
          id: reg.sessionId,
          provider: 'claude',
          cwd: reg.cwd,
          name: reg.name,
          preview: reg.preview,
          status: 'error',
          createdAt: reg.createdAt,
          updatedAt: reg.updatedAt,
        });
      }
    }

    return sessions;
  }

  async readTranscript(sessionId: string, limit = 50): Promise<Transcript> {
    if (useMock()) {
      const s = this.mockSessions.get(sessionId);
      if (!s) throw new Error(`Unknown mock session: ${sessionId}`);
      const items = s.items.slice(-Math.max(1, limit));
      return { sessionId, provider: 'claude', items };
    }

    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.sessionId === sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}. Use listSessions to find Wingman-managed sessions.`);
    }

    const sdk = await this.importSdk();
    const messages = await sdk.getSessionMessages(sessionId, {
      dir: session.cwd,
      limit,
    });

    const items: TranscriptItem[] = messages.map((msg) => ({
      role: msg.type === 'user' ? 'user' : 'assistant',
      text: extractMessageText(msg.message),
      itemId: msg.uuid,
    }));

    return { sessionId, provider: 'claude', items };
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
        text: `[mock Claude] Received: ${text}`,
        turnId,
      });
      s.preview = text.slice(0, 80);
      s.updatedAt = Date.now();
      s.activeTurnId = undefined;
      return { sessionId, turnId, status: 'completed' };
    }

    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.sessionId === sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}. Use createSession or listSessions first.`);
    }

    const sdk = await this.importSdk();

    const q = sdk.query({
      prompt: text,
      options: {
        resume: sessionId,
        cwd: session.cwd,
        maxTurns: 1,
      },
    });

    this.activeQueries.set(sessionId, q);
    let turnId: string | undefined;
    let status = 'in_progress';

    try {
      for await (const msg of q) {
        if (msg.type === 'system' && 'session_id' in msg) {
          turnId = (msg as { session_id?: string }).session_id;
        }
        if (msg.type === 'result') {
          status = 'completed';
          turnId = (msg as { session_id?: string }).session_id ?? turnId;
        }
      }
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      this.activeQueries.delete(sessionId);
      updateSessionTimestamp(sessionId);
    }

    return { sessionId, turnId, status };
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

    const activeQuery = this.activeQueries.get(sessionId);
    if (!activeQuery) {
      return {
        sessionId,
        status: 'no_active_turn',
      };
    }

    try {
      await activeQuery.interrupt();
      this.activeQueries.delete(sessionId);
      return { sessionId, status: 'interrupted' };
    } catch (err) {
      return {
        sessionId,
        status: 'interrupt_failed',
        turnId: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async createSession(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    const cwd = opts?.cwd ?? process.cwd();

    if (useMock()) {
      const s = this.seedMock({
        cwd,
        name: 'mock-claude-created',
        preview: opts?.prompt?.slice(0, 80),
      });
      if (opts?.prompt) {
        await this.sendMessage(s.sessionId, opts.prompt);
      }
      return { sessionId: s.sessionId, provider: 'claude', cwd };
    }

    const sdk = await this.importSdk();
    const sessionId = randomUUID();
    const now = Date.now();

    const wingmanSession: WingmanClaudeSession = {
      sessionId,
      cwd,
      name: opts?.prompt?.slice(0, 40) || 'Wingman session',
      preview: opts?.prompt?.slice(0, 80),
      createdAt: now,
      updatedAt: now,
    };

    registerSession(wingmanSession);

    if (opts?.prompt) {
      const q = sdk.query({
        prompt: opts.prompt,
        options: {
          sessionId,
          cwd,
          maxTurns: 1,
        },
      });

      this.activeQueries.set(sessionId, q);
      try {
        for await (const msg of q) {
          if (msg.type === 'result') break;
        }
      } finally {
        this.activeQueries.delete(sessionId);
        updateSessionTimestamp(sessionId);
      }
    }

    return { sessionId, provider: 'claude', cwd };
  }
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';

  const msg = message as Record<string, unknown>;

  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;

  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return JSON.stringify(message).slice(0, 200);
}
