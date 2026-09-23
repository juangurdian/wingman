/**
 * Claude provider with session discovery via @anthropic-ai/claude-agent-sdk.
 *
 * Discovery mode (default on, CLAUDE_DISCOVER=0 to disable):
 * - Discovers sessions from the Claude Agent SDK / on-disk store (~/.claude/projects/)
 * - Merges discovered sessions with Wingman's own registry (deduplicated by id)
 * - Allows resuming discovered sessions via SDK query({ options: { resume: sessionId } })
 *
 * This does NOT attach to arbitrary open terminal processes.
 * Discovery = SDK listSessions / getSessionMessages + resume via query().
 *
 * Mock mode (CLAUDE_MOCK=1):
 * - Returns simulated discovered sessions for testing merge/dedupe without a real Claude install.
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

interface WingmanClaudeSession {
  sessionId: string;
  cwd: string;
  name?: string;
  preview?: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionRegistry {
  sessions: WingmanClaudeSession[];
}

interface MockDiscoveredSession {
  id: string;
  cwd?: string;
  name?: string;
  preview?: string;
  firstPrompt?: string;
  gitBranch?: string;
  tag?: string;
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  activeTurnId?: string;
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

  private mockSessions = new Map<string, MockDiscoveredSession>();
  private mockDiscovered = new Map<string, MockDiscoveredSession>();

  constructor() {
    if (useMock()) {
      this.seedMockSessions();
    }
  }

  private seedMockSessions(): void {
    const now = Date.now();

    const wingmanDemo: MockDiscoveredSession = {
      id: `claude_mock_${randomUUID().slice(0, 8)}`,
      cwd: process.cwd(),
      name: 'mock-claude-demo',
      preview: 'Hello from mock Claude',
      createdAt: now,
      updatedAt: now,
      items: [
        { role: 'user', text: 'Hello from mock Claude', turnId: 'turn_mock_1' },
        {
          role: 'assistant',
          text: 'Mock Claude ready. Set CLAUDE_MOCK=0 and install Claude Code for real mode.',
          turnId: 'turn_mock_1',
        },
      ],
    };
    this.mockSessions.set(wingmanDemo.id, wingmanDemo);

    if (discoveryEnabled()) {
      const disc1: MockDiscoveredSession = {
        id: `sess_discovered_${randomUUID().slice(0, 8)}`,
        cwd: '/home/user/projects/alpha',
        name: 'Discovered: Alpha Project',
        preview: 'Help me refactor the auth module',
        firstPrompt: 'Help me refactor the auth module',
        gitBranch: 'main',
        tag: 'refactor',
        createdAt: now - 3600000,
        updatedAt: now - 1800000,
        items: [
          { role: 'user', text: 'Help me refactor the auth module', turnId: 'turn_disc_1' },
          { role: 'assistant', text: '[mock discovered] I can help with the auth module refactor.', turnId: 'turn_disc_1' },
        ],
      };
      const disc2: MockDiscoveredSession = {
        id: `sess_discovered_${randomUUID().slice(0, 8)}`,
        cwd: '/home/user/projects/beta',
        name: 'Discovered: Beta Tests',
        preview: 'Run the test suite',
        firstPrompt: 'Run the test suite and fix failures',
        gitBranch: 'feature/tests',
        createdAt: now - 7200000,
        updatedAt: now - 3600000,
        items: [
          { role: 'user', text: 'Run the test suite and fix failures', turnId: 'turn_disc_2' },
          { role: 'assistant', text: '[mock discovered] Running tests...', turnId: 'turn_disc_2' },
        ],
      };
      this.mockDiscovered.set(disc1.id, disc1);
      this.mockDiscovered.set(disc2.id, disc2);
    }
  }

  private seedMock(opts?: { cwd?: string; name?: string; preview?: string }): MockDiscoveredSession {
    const now = Date.now();
    const s: MockDiscoveredSession = {
      id: `claude_mock_${randomUUID().slice(0, 8)}`,
      cwd: opts?.cwd ?? process.cwd(),
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
      const wingmanSessions: SessionSummary[] = [...this.mockSessions.values()].map((s) => ({
        id: s.id,
        provider: 'claude' as const,
        cwd: s.cwd,
        name: s.name,
        preview: s.preview,
        status: s.activeTurnId ? 'active' : 'idle',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        source: 'wingman' as const,
      }));

      if (!discoveryEnabled()) {
        return wingmanSessions;
      }

      const discovered: SessionSummary[] = [...this.mockDiscovered.values()].map((s) => ({
        id: s.id,
        provider: 'claude' as const,
        cwd: s.cwd,
        name: s.name,
        preview: s.preview ?? s.firstPrompt,
        status: s.activeTurnId ? 'active' : 'idle',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        source: 'discovered' as const,
        gitBranch: s.gitBranch,
        tag: s.tag,
      }));

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

    const registry = loadRegistry();
    const wingmanSessions: SessionSummary[] = registry.sessions.map((reg) => ({
      id: reg.sessionId,
      provider: 'claude' as const,
      cwd: reg.cwd,
      name: reg.name,
      preview: reg.preview,
      status: 'idle',
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt,
      source: 'wingman' as const,
    }));

    if (!discoveryEnabled()) {
      return wingmanSessions;
    }

    const discovered = await this.discoverViaSdk();

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

  private async discoverViaSdk(): Promise<SessionSummary[]> {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
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
      const mock = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
      if (mock) {
        return {
          sessionId,
          provider: 'claude',
          items: mock.items.slice(-Math.max(1, limit)),
        };
      }
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.sessionId === sessionId);
    const cwd = session?.cwd;

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const messages = await sdk.getSessionMessages(sessionId, {
        dir: cwd,
        limit,
      });

      const items: TranscriptItem[] = messages.map((m) => ({
        role: m.type === 'user' ? 'user' : m.type === 'assistant' ? 'assistant' : 'system',
        text: extractMessageText(m.message),
        turnId: m.uuid,
        itemId: m.uuid,
        type: m.type,
      }));

      return { sessionId, provider: 'claude', items };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read Claude session transcript: ${msg}`);
    }
  }

  async sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
      if (mock) {
        const turnId = `turn_mock_${randomUUID().slice(0, 8)}`;
        mock.activeTurnId = turnId;
        mock.items.push({ role: 'user', text, turnId });
        mock.items.push({
          role: 'assistant',
          text: `[mock Claude] Received: ${text}`,
          turnId,
        });
        mock.preview = text.slice(0, 80);
        mock.updatedAt = Date.now();
        mock.activeTurnId = undefined;
        return { sessionId, turnId, status: 'completed' };
      }
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.sessionId === sessionId);

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      let turnId: string | undefined;
      let status = 'inProgress';

      const queryGen = sdk.query({
        prompt: text,
        options: {
          resume: sessionId,
          cwd: session?.cwd,
          maxTurns: 1,
        },
      });

      for await (const msg of queryGen) {
        if (msg.type === 'result') {
          turnId = msg.session_id;
          status = msg.subtype === 'success' ? 'completed' : msg.subtype;
          break;
        }
      }

      if (!session) {
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
      } else {
        updateSessionTimestamp(sessionId);
      }

      return { sessionId, turnId, status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send message to Claude session: ${msg}`);
    }
  }

  async interrupt(sessionId: string): Promise<InterruptResult> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
      if (mock) {
        const turnId = mock.activeTurnId;
        mock.activeTurnId = undefined;
        mock.items.push({
          role: 'system',
          text: '[mock] Interrupted',
          turnId,
        });
        return { sessionId, turnId, status: 'interrupted' };
      }
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    throw new Error(
      'Claude interrupt requires an active query handle. ' +
        'Call send_message and interrupt via the returned Query object, or use the Claude CLI directly.',
    );
  }

  async createSession(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    if (useMock()) {
      const s = this.seedMock({
        cwd: opts?.cwd ?? process.cwd(),
        name: 'mock-claude-created',
        preview: opts?.prompt?.slice(0, 80),
      });

      if (opts?.prompt) {
        await this.sendMessage(s.id, opts.prompt);
      }

      return { sessionId: s.id, provider: 'claude', cwd: s.cwd };
    }

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      const sessionId: string = randomUUID();
      let resultSessionId: string = sessionId;

      const queryGen = sdk.query({
        prompt: opts?.prompt ?? '',
        options: {
          sessionId: sessionId as `${string}-${string}-${string}-${string}-${string}`,
          cwd: opts?.cwd,
          maxTurns: opts?.prompt ? 1 : 0,
        },
      });

      for await (const msg of queryGen) {
        if (msg.type === 'system' && 'session_id' in msg) {
          resultSessionId = (msg as { session_id?: string }).session_id ?? sessionId;
        }
        if (msg.type === 'result') {
          resultSessionId = msg.session_id ?? resultSessionId;
          break;
        }
      }

      const now = Date.now();
      registerSession({
        sessionId: resultSessionId,
        cwd: opts?.cwd ?? process.cwd(),
        name: opts?.prompt?.slice(0, 40) || 'Wingman session',
        preview: opts?.prompt?.slice(0, 80),
        createdAt: now,
        updatedAt: now,
      });

      return { sessionId: resultSessionId, provider: 'claude', cwd: opts?.cwd };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create Claude session: ${msg}`);
    }
  }
}

function extractMessageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';

  const m = message as Record<string, unknown>;

  if (typeof m.text === 'string') return m.text;

  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const block = c as Record<string, unknown>;
          if (typeof block.text === 'string') return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (typeof m.content === 'string') return m.content;

  return JSON.stringify(message);
}
