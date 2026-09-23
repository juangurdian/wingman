/**
 * Claude Code provider using the official Agent SDK.
 *
 * This provider manages:
 * 1. Wingman-created sessions tracked in ~/.wingman/claude-sessions.json
 * 2. Discovery of existing Claude sessions via SDK listSessions() (when enabled)
 *
 * Discovery mode (default on, CLAUDE_DISCOVER=0 to disable):
 * - Discovers sessions from the Claude Agent SDK / on-disk store (~/.claude/projects/)
 * - Merges discovered sessions with Wingman's registry (deduplicated by id)
 * - Allows resuming discovered sessions via SDK query({ options: { resume: sessionId } })
 *
 * This does NOT attach to arbitrary open terminal processes.
 * Discovery = SDK listSessions / getSessionMessages + resume via query().
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
type GetSessionInfoType = typeof import('@anthropic-ai/claude-agent-sdk').getSessionInfo;
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
  gitBranch?: string;
  tag?: string;
  isDiscovered?: boolean;
}

interface SessionRegistry {
  sessions: WingmanClaudeSession[];
}

function useMock(): boolean {
  return process.env.CLAUDE_MOCK === '1' || process.env.CLAUDE_MOCK === 'true';
}

function discoveryEnabled(): boolean {
  const env = process.env.CLAUDE_DISCOVER;
  if (env === '0' || env === 'false') return false;
  return true;
}

function discoverDirs(): string[] | undefined {
  const env = process.env.CLAUDE_DISCOVER_DIRS?.trim();
  if (!env) return undefined;
  return env.split(':').map((d) => d.trim()).filter(Boolean);
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
    getSessionInfo: GetSessionInfoType;
  }> | null = null;

  constructor() {
    if (useMock()) {
      this.seedMockSessions();
    }
  }

  private seedMockSessions(): void {
    const now = Date.now();

    const wingmanSession = this.seedMock({ cwd: process.cwd(), name: 'mock-claude-demo' });
    wingmanSession.items.push(
      { role: 'user', text: 'Hello from mock Claude', turnId: 'turn_mock_1' },
      {
        role: 'assistant',
        text: 'Mock Claude ready. Set CLAUDE_MOCK=0 and install Claude Code for real mode.',
        turnId: 'turn_mock_1',
      },
    );
    wingmanSession.preview = 'Hello from mock Claude';

    if (discoveryEnabled()) {
      const disc1: MockSession = {
        sessionId: `sess_discovered_${randomUUID().slice(0, 8)}`,
        cwd: '/home/user/projects/alpha',
        name: 'Discovered: Alpha Project',
        preview: 'Help me refactor the auth module',
        createdAt: now - 3600000,
        updatedAt: now - 1800000,
        items: [
          { role: 'user', text: 'Help me refactor the auth module', turnId: 'turn_disc_1' },
          { role: 'assistant', text: '[mock discovered] I can help with the auth module refactor.', turnId: 'turn_disc_1' },
        ],
        gitBranch: 'main',
        tag: 'refactor',
        isDiscovered: true,
      };
      const disc2: MockSession = {
        sessionId: `sess_discovered_${randomUUID().slice(0, 8)}`,
        cwd: '/home/user/projects/beta',
        name: 'Discovered: Beta Tests',
        preview: 'Run the test suite',
        createdAt: now - 7200000,
        updatedAt: now - 3600000,
        items: [
          { role: 'user', text: 'Run the test suite and fix failures', turnId: 'turn_disc_2' },
          { role: 'assistant', text: '[mock discovered] Running tests...', turnId: 'turn_disc_2' },
        ],
        gitBranch: 'feature/tests',
        isDiscovered: true,
      };
      this.mockSessions.set(disc1.sessionId, disc1);
      this.mockSessions.set(disc2.sessionId, disc2);
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
      isDiscovered: false,
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
      getSessionInfo: sdk.getSessionInfo,
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
        source: s.isDiscovered ? 'discovered' as const : 'wingman' as const,
        gitBranch: s.gitBranch,
        tag: s.tag,
      }));
    }

    const registry = loadRegistry();
    const sdk = await this.importSdk();

    const wingmanSessions: SessionSummary[] = [];
    for (const reg of registry.sessions) {
      try {
        const sdkSessions = await sdk.listSessions({ dir: reg.cwd, limit: 50 });
        const found = sdkSessions.find((s) => s.sessionId === reg.sessionId);
        if (found) {
          wingmanSessions.push({
            id: found.sessionId,
            provider: 'claude',
            cwd: found.cwd ?? reg.cwd,
            name: found.customTitle ?? reg.name,
            preview: found.firstPrompt ?? reg.preview,
            status: 'idle',
            createdAt: found.createdAt ?? reg.createdAt,
            updatedAt: found.lastModified ?? reg.updatedAt,
            source: 'wingman',
            gitBranch: found.gitBranch,
            tag: found.tag,
          });
        } else {
          wingmanSessions.push({
            id: reg.sessionId,
            provider: 'claude',
            cwd: reg.cwd,
            name: reg.name,
            preview: reg.preview,
            status: 'unknown',
            createdAt: reg.createdAt,
            updatedAt: reg.updatedAt,
            source: 'wingman',
          });
        }
      } catch {
        wingmanSessions.push({
          id: reg.sessionId,
          provider: 'claude',
          cwd: reg.cwd,
          name: reg.name,
          preview: reg.preview,
          status: 'error',
          createdAt: reg.createdAt,
          updatedAt: reg.updatedAt,
          source: 'wingman',
        });
      }
    }

    if (!discoveryEnabled()) {
      return wingmanSessions;
    }

    const discovered = await this.discoverViaSdk(sdk);

    const wingmanIds = new Set(wingmanSessions.map((s) => s.id));
    const merged = [...wingmanSessions];
    for (const ds of discovered) {
      if (!wingmanIds.has(ds.id)) {
        merged.push(ds);
      }
    }

    merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return merged;
  }

  private async discoverViaSdk(sdk: Awaited<ReturnType<typeof this.importSdk>>): Promise<SessionSummary[]> {
    try {
      const dirs = discoverDirs();

      let sessions: Awaited<ReturnType<typeof sdk.listSessions>>;
      if (dirs && dirs.length > 0) {
        const allSessions: typeof sessions = [];
        for (const dir of dirs) {
          try {
            const dirSessions = await sdk.listSessions({ dir, limit: 100 });
            allSessions.push(...dirSessions);
          } catch {
            // Directory may not have sessions
          }
        }
        sessions = allSessions;
      } else {
        sessions = await sdk.listSessions({ limit: 200 });
      }

      return sessions.map((s) => ({
        id: s.sessionId,
        provider: 'claude' as const,
        cwd: s.cwd,
        name: s.customTitle ?? s.summary,
        preview: s.firstPrompt ?? s.summary,
        status: 'idle',
        createdAt: s.createdAt,
        updatedAt: s.lastModified,
        source: 'discovered' as const,
        gitBranch: s.gitBranch,
        tag: s.tag,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Native CLI binary') || msg.includes('ENOENT')) {
        return [];
      }
      throw err;
    }
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
    const cwd = session?.cwd;

    const sdk = await this.importSdk();
    try {
      const messages = await sdk.getSessionMessages(sessionId, {
        dir: cwd,
        limit,
      });

      const items: TranscriptItem[] = messages.map((msg) => ({
        role: msg.type === 'user' ? 'user' : msg.type === 'assistant' ? 'assistant' : 'system',
        text: extractMessageText(msg.message),
        itemId: msg.uuid,
        turnId: msg.uuid,
        type: msg.type,
      }));

      return { sessionId, provider: 'claude', items };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read Claude session transcript: ${msg}`);
    }
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

    const sdk = await this.importSdk();

    const q = sdk.query({
      prompt: text,
      options: {
        resume: sessionId,
        cwd: session?.cwd,
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
          turnId = msg.session_id ?? turnId;
        }
      }
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      this.activeQueries.delete(sessionId);
    }

    if (!session) {
      try {
        const info = await sdk.getSessionInfo(sessionId);
        if (info) {
          registerSession({
            sessionId,
            cwd: info.cwd ?? process.cwd(),
            name: info.customTitle ?? info.summary,
            preview: text.slice(0, 80),
            createdAt: info.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch {
        // Best effort registration
      }
    } else {
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
          sessionId: sessionId as `${string}-${string}-${string}-${string}-${string}`,
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
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';

  const msg = message as Record<string, unknown>;

  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;

  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        const b = block as { type?: string; text?: string };
        if (typeof b.text === 'string') return b.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return JSON.stringify(message).slice(0, 200);
}
