/**
 * Muse provider for Muse Code sessions via Muse Session Protocol (MSP).
 *
 * Target API: Meta Muse Session Protocol via `muse serve` / `@muse-code/sdk`
 * Reference: https://github.com/meta-models/muse-code-sdk
 *
 * Mock mode (MUSE_MOCK=1):
 * - Returns simulated sessions for testing MCP wiring without a real `muse` binary.
 * - Exercises the full MCP surface: list_sessions, create_session, send_message, etc.
 *
 * Real mode (unset MUSE_MOCK):
 * - Connects to `muse serve` via the Muse Session Protocol.
 * - Falls back gracefully if muse binary is not available.
 *
 * Note: This provider does NOT claim TTY hijack of arbitrary Muse TUIs.
 * Like Claude, it manages Wingman-owned / MSP sessions, not interactive terminals.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  CreateSessionResult,
  InterruptResult,
  ListApprovalsResult,
  ResolveApprovalResult,
  SendMessageResult,
  SessionDetail,
  SessionProvider,
  SessionSummary,
  SteerResult,
  Transcript,
  TranscriptItem,
  WaitTurnOptions,
  WaitTurnResult,
  SetSessionMetaOptions,
  SetSessionMetaResult,
} from './types.js';
import {
  resolveWaitTurnTimeoutMs,
  resolveWaitTurnPollMs,
} from '../config.js';

interface WingmanMuseSession {
  sessionId: string;
  cwd: string;
  name?: string;
  preview?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

interface SessionRegistry {
  sessions: WingmanMuseSession[];
}

interface MockSession {
  id: string;
  cwd?: string;
  name?: string;
  preview?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  activeTurnId?: string;
  turnStartedAt?: number;
}

interface ActiveTurn {
  turnId: string;
  sessionId: string;
  startedAt: number;
  abortController?: AbortController;
}

function useMock(): boolean {
  return process.env.MUSE_MOCK === '1' || process.env.MUSE_MOCK === 'true';
}

function registryPath(): string {
  return join(homedir(), '.wingman', 'muse-sessions.json');
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

function registerSession(session: WingmanMuseSession): void {
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

export class MuseProvider implements SessionProvider {
  readonly name = 'muse' as const;

  private mockSessions = new Map<string, MockSession>();
  private activeTurns = new Map<string, ActiveTurn>();

  constructor() {
    if (useMock()) {
      this.seedMockSessions();
    }
  }

  getActiveTurn(sessionId: string): ActiveTurn | undefined {
    return this.activeTurns.get(sessionId);
  }

  getSessionStatus(sessionId: string): 'idle' | 'running' {
    return this.activeTurns.has(sessionId) ? 'running' : 'idle';
  }

  private seedMockSessions(): void {
    const now = Date.now();

    const demoSession: MockSession = {
      id: `muse_mock_${randomUUID().slice(0, 8)}`,
      cwd: process.cwd(),
      name: 'mock-muse-demo',
      preview: 'Hello from mock Muse',
      createdAt: now,
      updatedAt: now,
      items: [
        { role: 'user', text: 'Hello from mock Muse', turnId: 'turn_mock_1' },
        {
          role: 'assistant',
          text: 'Mock Muse ready. Set MUSE_MOCK=0 and install Muse Code for real mode.',
          turnId: 'turn_mock_1',
        },
      ],
    };
    this.mockSessions.set(demoSession.id, demoSession);
  }

  private seedMock(opts?: { cwd?: string; name?: string; preview?: string; tags?: string[] }): MockSession {
    const now = Date.now();
    const s: MockSession = {
      id: `muse_mock_${randomUUID().slice(0, 8)}`,
      cwd: opts?.cwd ?? process.cwd(),
      name: opts?.name,
      preview: opts?.preview,
      tags: opts?.tags,
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
        provider: 'muse' as const,
        cwd: s.cwd,
        name: s.name,
        preview: s.preview,
        status: this.activeTurns.has(s.id) ? 'running' : (s.activeTurnId ? 'active' : 'idle'),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        source: 'wingman' as const,
        tags: s.tags,
      }));
    }

    const registry = loadRegistry();
    return registry.sessions.map((reg) => ({
      id: reg.sessionId,
      provider: 'muse' as const,
      cwd: reg.cwd,
      name: reg.name,
      preview: reg.preview,
      status: this.activeTurns.has(reg.sessionId) ? 'running' : 'idle',
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt,
      source: 'wingman' as const,
      tags: reg.tags,
    }));
  }

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;

    const activeTurn = this.activeTurns.get(sessionId);
    return {
      ...session,
      status: activeTurn ? 'running' : 'idle',
      activeTurnId: activeTurn?.turnId,
      activeTurnStartedAt: activeTurn?.startedAt,
    };
  }

  async readTranscript(sessionId: string, limit = 50): Promise<Transcript> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId);
      if (mock) {
        return {
          sessionId,
          provider: 'muse',
          items: mock.items.slice(-Math.max(1, limit)),
        };
      }
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    // Real mode: read from MSP session file
    // TODO: Implement real MSP session reading when API is available
    throw new Error(
      `Muse real mode not yet implemented. Set MUSE_MOCK=1 or wait for MSP API integration.`
    );
  }

  async sendMessage(sessionId: string, text: string): Promise<SendMessageResult> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId);
      if (mock) {
        const turnId = `turn_mock_${randomUUID().slice(0, 8)}`;
        mock.activeTurnId = turnId;
        mock.turnStartedAt = Date.now();
        this.activeTurns.set(sessionId, { turnId, sessionId, startedAt: Date.now() });
        mock.items.push({ role: 'user', text, turnId });

        setTimeout(() => {
          mock.items.push({
            role: 'assistant',
            text: `[mock Muse] Received: ${text}`,
            turnId,
          });
          mock.preview = text.slice(0, 80);
          mock.updatedAt = Date.now();
          mock.activeTurnId = undefined;
          mock.turnStartedAt = undefined;
          this.activeTurns.delete(sessionId);
        }, 50);

        return { sessionId, turnId, status: 'accepted' };
      }
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    // Real mode: send via MSP
    // TODO: Implement real MSP message sending
    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.sessionId === sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}. Create a session first.`);
    }

    throw new Error(
      `Muse real mode not yet implemented. Set MUSE_MOCK=1 or wait for MSP API integration.`
    );
  }

  async interrupt(sessionId: string): Promise<InterruptResult> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId);
      if (mock) {
        const activeTurn = this.activeTurns.get(sessionId);
        const turnId = activeTurn?.turnId ?? mock.activeTurnId;

        if (activeTurn) {
          activeTurn.abortController?.abort();
          this.activeTurns.delete(sessionId);
        }
        mock.activeTurnId = undefined;
        mock.turnStartedAt = undefined;

        mock.items.push({
          role: 'system',
          text: '[mock] Interrupted',
          turnId,
        });
        return { sessionId, turnId, status: 'interrupted' };
      }
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) {
      return {
        sessionId,
        turnId: undefined,
        status: 'no_active_turn',
      };
    }

    activeTurn.abortController?.abort();
    this.activeTurns.delete(sessionId);

    return {
      sessionId,
      turnId: activeTurn.turnId,
      status: 'interrupted',
    };
  }

  async createSession(opts?: { cwd?: string; prompt?: string; name?: string; tags?: string[] }): Promise<CreateSessionResult> {
    if (useMock()) {
      const s = this.seedMock({
        cwd: opts?.cwd ?? process.cwd(),
        name: opts?.name ?? 'mock-muse-created',
        preview: opts?.prompt?.slice(0, 80),
        tags: opts?.tags,
      });

      if (opts?.prompt) {
        const sendResult = await this.sendMessage(s.id, opts.prompt);
        return {
          sessionId: s.id,
          provider: 'muse',
          cwd: s.cwd,
          status: 'accepted',
          turnId: sendResult.turnId,
        };
      }

      return { sessionId: s.id, provider: 'muse', cwd: s.cwd, status: 'created' };
    }

    // Real mode: create session via MSP
    const sessionId = `muse_${randomUUID()}`;
    const now = Date.now();

    registerSession({
      sessionId,
      cwd: opts?.cwd ?? process.cwd(),
      name: opts?.name ?? opts?.prompt?.slice(0, 40) ?? 'Wingman Muse session',
      preview: opts?.prompt?.slice(0, 80),
      tags: opts?.tags,
      createdAt: now,
      updatedAt: now,
    });

    // TODO: When MSP API is available, actually create the session
    // For now, we register locally but real operations will fail

    return { sessionId, provider: 'muse', cwd: opts?.cwd, status: 'created' };
  }

  async waitTurn(sessionId: string, opts?: WaitTurnOptions): Promise<WaitTurnResult> {
    const timeoutMs = opts?.timeoutMs ?? resolveWaitTurnTimeoutMs();
    const pollIntervalMs = opts?.pollIntervalMs ?? resolveWaitTurnPollMs();

    if (useMock()) {
      const mock = this.mockSessions.get(sessionId);
      if (!mock) throw new Error(`Unknown mock session: ${sessionId}`);

      const activeTurn = this.activeTurns.get(sessionId);
      if (!activeTurn) {
        const lastAssistant = [...mock.items].reverse().find((i) => i.role === 'assistant');
        return {
          sessionId,
          status: 'idle',
          latestMessage: lastAssistant?.text?.slice(0, 200),
        };
      }

      const turnId = activeTurn.turnId;
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        const currentTurn = this.activeTurns.get(sessionId);
        if (!currentTurn || currentTurn.turnId !== turnId) {
          const lastAssistant = [...mock.items]
            .reverse()
            .find((i) => i.role === 'assistant' && i.turnId === turnId);
          return {
            sessionId,
            turnId,
            status: 'completed',
            latestMessage: lastAssistant?.text?.slice(0, 200),
          };
        }
      }

      return { sessionId, turnId, status: 'timeout' };
    }

    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) {
      return { sessionId, status: 'idle' };
    }

    const turnId = activeTurn.turnId;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnId !== turnId) {
        return { sessionId, turnId, status: 'completed' };
      }
    }

    return { sessionId, turnId, status: 'timeout' };
  }

  async steer(_sessionId: string, _text: string): Promise<SteerResult> {
    // Muse does not support mid-turn steering (similar to Claude)
    return {
      sessionId: _sessionId,
      accepted: false,
      error:
        'Muse does not support mid-turn steering. Use interrupt() to stop the current turn, ' +
        'then send_message() with your new instructions.',
    };
  }

  async listApprovals(sessionId: string): Promise<ListApprovalsResult> {
    // Muse does not have programmatic approval handling (similar to Claude)
    return {
      sessionId,
      approvals: [],
    };
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<ResolveApprovalResult> {
    // Muse does not support programmatic approval resolution (similar to Claude)
    return {
      sessionId,
      approvalId,
      resolved: false,
      error:
        'Muse does not support programmatic approval resolution. Approvals must be handled ' +
        'in the local Muse session directly.',
    };
  }

  async setSessionMeta(
    sessionId: string,
    meta: SetSessionMetaOptions,
  ): Promise<SetSessionMetaResult> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId);
      if (!mock) {
        return {
          sessionId,
          updated: false,
          error: `Session not found: ${sessionId}`,
        };
      }
      if (meta.name !== undefined) mock.name = meta.name;
      if (meta.tags !== undefined) mock.tags = meta.tags;
      mock.updatedAt = Date.now();
      return {
        sessionId,
        updated: true,
        name: mock.name,
        tags: mock.tags,
      };
    }

    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.sessionId === sessionId);
    if (!session) {
      return {
        sessionId,
        updated: false,
        error: `Session not found in Wingman registry: ${sessionId}. Only Wingman-owned sessions can have metadata set.`,
      };
    }

    if (meta.name !== undefined) session.name = meta.name;
    if (meta.tags !== undefined) session.tags = meta.tags;
    session.updatedAt = Date.now();
    saveRegistry(registry);

    return {
      sessionId,
      updated: true,
      name: session.name,
      tags: session.tags,
    };
  }
}
