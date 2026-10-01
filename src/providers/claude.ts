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
 * Permissions:
 * - Tool calls that need permission are parked as approvals (list_approvals / resolve_approval)
 *   via the SDK's canUseTool callback, so a remote host can approve or decline them.
 * - CLAUDE_PERMISSION_MODE (default | acceptEdits | plan | dontAsk | auto) and CLAUDE_MAX_TURNS
 *   tune Wingman-run turns.
 *
 * Mock mode (CLAUDE_MOCK=1):
 * - Returns simulated discovered sessions for testing merge/dedupe without a real Claude install.
 * - Messages containing `sudo` or `rm -rf` request a simulated approval.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Approval,
  ApprovalDecision,
  ApprovalKind,
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
  resolveClaudeSendTimeoutMs,
  resolveClaudeMaxTurns,
  resolveClaudePermissionMode,
  resolveWaitTurnTimeoutMs,
  resolveHostId,
  resolveHostName,
} from '../config.js';

interface WingmanClaudeSession {
  sessionId: string;
  cwd: string;
  name?: string;
  preview?: string;
  tags?: string[];
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
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  activeTurnId?: string;
}

interface ActiveTurn {
  turnId: string;
  sessionId: string;
  startedAt: number;
  abortController?: AbortController;
}

interface PendingClaudeApproval {
  approval: Approval;
  /** Full (untruncated) tool input, echoed back to the SDK on allow. */
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  settle: (result: PermissionResult) => void;
}

interface TurnOutcome {
  turnId: string;
  status: 'completed' | 'failed' | 'interrupted';
  error?: string;
}

/** Mock messages matching this request a simulated approval (mirrors the Codex mock). */
const MOCK_APPROVAL_PATTERN = /\b(sudo|rm\s+-rf?)\b/i;

/** Long tool inputs (e.g. Write content) are truncated in list_approvals output. */
const MAX_APPROVAL_INPUT_CHARS = 2000;

function approvalKind(toolName: string): ApprovalKind {
  if (toolName === 'Bash') return 'command';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName)) return 'fileChange';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'network';
  return 'tool';
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] =
      typeof value === 'string' && value.length > MAX_APPROVAL_INPUT_CHARS
        ? `${value.slice(0, MAX_APPROVAL_INPUT_CHARS)}… [${value.length - MAX_APPROVAL_INPUT_CHARS} more chars]`
        : value;
  }
  return out;
}

/** acceptForSession must never write to settings files, so pin suggestions to the session. */
function toSessionScope(suggestions?: PermissionUpdate[]): PermissionUpdate[] | undefined {
  return suggestions?.map((s) => ({ ...s, destination: 'session' as const }));
}

function toPermissionResult(decision: ApprovalDecision, pending: PendingClaudeApproval): PermissionResult {
  switch (decision) {
    case 'accept':
      return { behavior: 'allow', updatedInput: pending.input };
    case 'acceptForSession':
      return {
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: toSessionScope(pending.suggestions),
      };
    case 'decline':
      return { behavior: 'deny', message: 'Declined by the remote approver (Wingman).' };
    case 'cancel':
      return {
        behavior: 'deny',
        message: 'Cancelled by the remote approver (Wingman).',
        interrupt: true,
      };
  }
}

/** Map the SDK's final result message to how the turn ended. */
function outcomeFromResult(turnId: string, msg: Extract<SDKMessage, { type: 'result' }>): TurnOutcome {
  if (msg.subtype !== 'success') {
    return { turnId, status: 'failed', error: msg.errors?.join('; ') || msg.subtype };
  }
  if (msg.is_error) {
    return { turnId, status: 'failed', error: msg.result || 'Claude turn ended with an error' };
  }
  return { turnId, status: 'completed' };
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
  private activeTurns = new Map<string, ActiveTurn>();
  private pendingApprovals = new Map<string, PendingClaudeApproval[]>();
  private lastOutcomes = new Map<string, TurnOutcome>();

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

  /**
   * Park a permission request until a host resolves it with resolve_approval,
   * or the turn is interrupted. Backs the SDK's canUseTool callback.
   */
  private requestApproval(
    sessionId: string,
    turnId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal?: AbortSignal; suggestions?: PermissionUpdate[]; reason?: string; cwd?: string },
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const pending: PendingClaudeApproval = {
        approval: {
          id: `appr_${randomUUID().slice(0, 8)}`,
          sessionId,
          turnId,
          kind: approvalKind(toolName),
          toolName,
          command: typeof input.command === 'string' ? input.command : undefined,
          cwd: opts.cwd,
          reason: opts.reason,
          input: summarizeInput(input),
          requestedAt: Date.now(),
        },
        input,
        suggestions: opts.suggestions,
        settle: (result) => {
          const remaining = (this.pendingApprovals.get(sessionId) ?? []).filter((p) => p !== pending);
          if (remaining.length > 0) {
            this.pendingApprovals.set(sessionId, remaining);
          } else {
            this.pendingApprovals.delete(sessionId);
          }
          resolve(result);
        },
      };
      this.pendingApprovals.set(sessionId, [...(this.pendingApprovals.get(sessionId) ?? []), pending]);
      opts.signal?.addEventListener(
        'abort',
        () => pending.settle({ behavior: 'deny', message: 'Turn aborted.', interrupt: true }),
        { once: true },
      );
    });
  }

  private denyPendingApprovals(sessionId: string, message: string): void {
    for (const pending of [...(this.pendingApprovals.get(sessionId) ?? [])]) {
      pending.settle({ behavior: 'deny', message, interrupt: true });
    }
  }

  private pendingApprovalCount(sessionId: string): number {
    return this.pendingApprovals.get(sessionId)?.length ?? 0;
  }

  /** SDK options shared by every Wingman-run turn. */
  private turnOptions(sessionId: string, cwd: string | undefined, activeTurn: ActiveTurn) {
    const canUseTool: CanUseTool = (toolName, input, { signal, suggestions, title, decisionReason }) =>
      this.requestApproval(sessionId, activeTurn.turnId, toolName, input, {
        signal,
        suggestions,
        reason: title ?? decisionReason,
        cwd,
      });
    return {
      cwd,
      abortController: activeTurn.abortController,
      permissionMode: resolveClaudePermissionMode(),
      maxTurns: resolveClaudeMaxTurns(),
      canUseTool,
    };
  }

  /** Drain an SDK query and record how the turn ended for wait_turn / get_session. */
  private async consumeTurn(
    sessionId: string,
    activeTurn: ActiveTurn,
    queryGen: AsyncIterable<SDKMessage>,
  ): Promise<void> {
    // An interrupted turn can drain after a newer turn started; don't let it
    // overwrite the newer turn's outcome.
    const record = (outcome: TurnOutcome) => {
      const current = this.activeTurns.get(sessionId);
      if (!current || current === activeTurn) this.lastOutcomes.set(sessionId, outcome);
    };
    let outcome: TurnOutcome = { turnId: activeTurn.turnId, status: 'completed' };
    try {
      for await (const msg of queryGen) {
        if (msg.type === 'result') {
          outcome = outcomeFromResult(activeTurn.turnId, msg);
          break;
        }
      }
    } catch (err) {
      if (!activeTurn.abortController?.signal.aborted) {
        const error = err instanceof Error ? err.message : String(err);
        record({ turnId: activeTurn.turnId, status: 'failed', error });
        throw err;
      }
    }
    if (activeTurn.abortController?.signal.aborted) {
      outcome = { turnId: activeTurn.turnId, status: 'interrupted' };
    }
    record(outcome);
  }

  /** Clear the active turn only if a newer turn has not replaced it. */
  private finishTurn(sessionId: string, activeTurn: ActiveTurn): void {
    if (this.activeTurns.get(sessionId) === activeTurn) {
      this.activeTurns.delete(sessionId);
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

  private seedMock(opts?: { cwd?: string; name?: string; preview?: string; tags?: string[] }): MockDiscoveredSession {
    const now = Date.now();
    const s: MockDiscoveredSession = {
      id: `claude_mock_${randomUUID().slice(0, 8)}`,
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
    const hostId = resolveHostId();
    const hostName = resolveHostName();
    
    if (useMock()) {
      const wingmanSessions: SessionSummary[] = [...this.mockSessions.values()].map((s) => ({
        id: s.id,
        provider: 'claude' as const,
        cwd: s.cwd,
        name: s.name,
        preview: s.preview,
        status: this.activeTurns.has(s.id) ? 'running' : (s.activeTurnId ? 'active' : 'idle'),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        source: 'wingman' as const,
        tags: s.tags,
        hostId,
        hostName,
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
        status: this.activeTurns.has(s.id) ? 'running' : (s.activeTurnId ? 'active' : 'idle'),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        source: 'discovered' as const,
        gitBranch: s.gitBranch,
        tag: s.tag,
        tags: s.tags ?? (s.tag ? [s.tag] : undefined),
        hostId,
        hostName,
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
      status: this.activeTurns.has(reg.sessionId) ? 'running' : 'idle',
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt,
      source: 'wingman' as const,
      tags: reg.tags,
      hostId,
      hostName,
    }));

    if (!discoveryEnabled()) {
      return wingmanSessions;
    }

    const discovered = await this.discoverViaSdk();

    const wingmanIds = new Set(wingmanSessions.map((s) => s.id));
    const merged = [...wingmanSessions];
    for (const ds of discovered) {
      if (!wingmanIds.has(ds.id)) {
        merged.push({ ...ds, hostId, hostName });
      }
    }

    merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return merged;
  }

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;

    const activeTurn = this.activeTurns.get(sessionId);
    const hostId = resolveHostId();
    const hostName = resolveHostName();
    const outcome = this.lastOutcomes.get(sessionId);
    
    return {
      ...session,
      status: activeTurn ? 'running' : 'idle',
      activeTurnId: activeTurn?.turnId,
      activeTurnStartedAt: activeTurn?.startedAt,
      pendingApprovals: this.pendingApprovalCount(sessionId),
      lastError: outcome?.status === 'failed' ? outcome.error : undefined,
      hostId,
      hostName,
    };
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
        this.activeTurns.set(sessionId, { turnId, sessionId, startedAt: Date.now() });
        mock.items.push({ role: 'user', text, turnId });

        const finish = (reply: string) => {
          mock.items.push({ role: 'assistant', text: reply, turnId });
          mock.preview = text.slice(0, 80);
          mock.updatedAt = Date.now();
          mock.activeTurnId = undefined;
          if (this.activeTurns.get(sessionId)?.turnId === turnId) {
            this.activeTurns.delete(sessionId);
            this.lastOutcomes.set(sessionId, { turnId, status: 'completed' });
          }
        };

        if (MOCK_APPROVAL_PATTERN.test(text)) {
          void this.requestApproval(sessionId, turnId, 'Bash', { command: text }, {
            cwd: mock.cwd,
            reason: '[mock] Claude wants to run a command',
          }).then((result) =>
            finish(
              result.behavior === 'allow'
                ? `[mock Claude] Ran: ${text}`
                : `[mock Claude] Did not run: ${result.message}`,
            ),
          );
        } else {
          setTimeout(() => finish(`[mock Claude] Received: ${text}`), 50);
        }

        return { sessionId, turnId, status: 'accepted' };
      }
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const registry = loadRegistry();
    const session = registry.sessions.find((s) => s.sessionId === sessionId);
    const turnId = `turn_${randomUUID().slice(0, 8)}`;

    const activeTurn: ActiveTurn = {
      turnId,
      sessionId,
      startedAt: Date.now(),
      abortController: new AbortController(),
    };
    this.activeTurns.set(sessionId, activeTurn);

    this.runTurnInBackground(sessionId, text, session?.cwd, activeTurn).catch((err) => {
      console.error(`[claude] Background turn error for ${sessionId}:`, err);
    });

    return { sessionId, turnId, status: 'accepted' };
  }

  private async runTurnInBackground(
    sessionId: string,
    text: string,
    cwd: string | undefined,
    activeTurn: ActiveTurn,
  ): Promise<void> {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      const queryGen = sdk.query({
        prompt: text,
        options: {
          ...this.turnOptions(sessionId, cwd, activeTurn),
          resume: sessionId,
        },
      });

      await this.consumeTurn(sessionId, activeTurn, queryGen);

      const registry = loadRegistry();
      const session = registry.sessions.find((s) => s.sessionId === sessionId);
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
    } finally {
      this.finishTurn(sessionId, activeTurn);
    }
  }

  async interrupt(sessionId: string): Promise<InterruptResult> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
      if (mock) {
        const activeTurn = this.activeTurns.get(sessionId);
        const turnId = activeTurn?.turnId ?? mock.activeTurnId;

        this.denyPendingApprovals(sessionId, 'Interrupted via Wingman.');
        if (activeTurn) {
          activeTurn.abortController?.abort();
          this.activeTurns.delete(sessionId);
        }
        mock.activeTurnId = undefined;
        if (turnId) {
          this.lastOutcomes.set(sessionId, { turnId, status: 'interrupted' });
        }

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

    this.denyPendingApprovals(sessionId, 'Interrupted via Wingman.');
    activeTurn.abortController?.abort();
    this.activeTurns.delete(sessionId);
    this.lastOutcomes.set(sessionId, { turnId: activeTurn.turnId, status: 'interrupted' });

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
        name: opts?.name ?? 'mock-claude-created',
        preview: opts?.prompt?.slice(0, 80),
        tags: opts?.tags,
      });

      if (opts?.prompt) {
        const sendResult = await this.sendMessage(s.id, opts.prompt);
        return {
          sessionId: s.id,
          provider: 'claude',
          cwd: s.cwd,
          status: 'accepted',
          turnId: sendResult.turnId,
        };
      }

      return { sessionId: s.id, provider: 'claude', cwd: s.cwd, status: 'created' };
    }

    try {
      const sessionId: string = randomUUID();
      const now = Date.now();

      registerSession({
        sessionId,
        cwd: opts?.cwd ?? process.cwd(),
        name: opts?.name ?? opts?.prompt?.slice(0, 40) ?? 'Wingman session',
        preview: opts?.prompt?.slice(0, 80),
        tags: opts?.tags,
        createdAt: now,
        updatedAt: now,
      });

      if (opts?.prompt) {
        const turnId = `turn_${randomUUID().slice(0, 8)}`;
        const activeTurn: ActiveTurn = {
          turnId,
          sessionId,
          startedAt: now,
          abortController: new AbortController(),
        };
        this.activeTurns.set(sessionId, activeTurn);

        this.runInitialTurnInBackground(sessionId, opts.prompt, opts.cwd, activeTurn).catch(
          (err) => {
            console.error(`[claude] Background initial turn error for ${sessionId}:`, err);
          },
        );

        return {
          sessionId,
          provider: 'claude',
          cwd: opts?.cwd,
          status: 'accepted',
          turnId,
        };
      }

      return { sessionId, provider: 'claude', cwd: opts?.cwd, status: 'created' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create Claude session: ${msg}`);
    }
  }

  private async runInitialTurnInBackground(
    sessionId: string,
    prompt: string,
    cwd: string | undefined,
    activeTurn: ActiveTurn,
  ): Promise<void> {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      const queryGen = sdk.query({
        prompt,
        options: {
          ...this.turnOptions(sessionId, cwd, activeTurn),
          sessionId: sessionId as `${string}-${string}-${string}-${string}-${string}`,
        },
      });

      await this.consumeTurn(sessionId, activeTurn, queryGen);

      updateSessionTimestamp(sessionId);
    } finally {
      this.finishTurn(sessionId, activeTurn);
    }
  }

  async waitTurn(sessionId: string, opts?: WaitTurnOptions): Promise<WaitTurnResult> {
    const timeoutMs = opts?.timeoutMs ?? resolveWaitTurnTimeoutMs();
    const pollIntervalMs = opts?.pollIntervalMs ?? 500;

    const mock = useMock()
      ? this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId)
      : undefined;
    if (useMock() && !mock) throw new Error(`Unknown mock session: ${sessionId}`);

    const latestAssistant = async (turnId?: string): Promise<string | undefined> => {
      const items = mock ? mock.items : (await this.readTranscript(sessionId, 10)).items;
      return [...items]
        .reverse()
        .find((i) => i.role === 'assistant' && (!mock || !turnId || i.turnId === turnId))
        ?.text?.slice(0, 200);
    };

    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) {
      // Report how the last turn ended, so a turn that finished between calls
      // (e.g. right after resolve_approval) reads as completed, not a bare idle.
      const outcome = this.lastOutcomes.get(sessionId);
      if (outcome) {
        let latestMessage: string | undefined;
        try {
          latestMessage = await latestAssistant(outcome.turnId);
        } catch {
          // Status still stands without a snippet.
        }
        return {
          sessionId,
          turnId: outcome.turnId,
          status: outcome.status,
          latestMessage,
          error: outcome.error,
        };
      }
      return {
        sessionId,
        status: 'idle',
        latestMessage: mock ? await latestAssistant() : undefined,
      };
    }

    const turnId = activeTurn.turnId;
    const awaitingApproval = (): WaitTurnResult | undefined => {
      const count = this.pendingApprovalCount(sessionId);
      if (count === 0) return undefined;
      return {
        sessionId,
        turnId,
        status: 'inProgress',
        pendingApprovals: count,
        latestMessage: `Waiting for ${count} approval(s) — see list_approvals`,
      };
    };

    const blocked = awaitingApproval();
    if (blocked) return blocked;

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnId !== turnId) {
        const outcome = this.lastOutcomes.get(sessionId);
        const ended = outcome?.turnId === turnId ? outcome : undefined;
        let latestMessage: string | undefined;
        try {
          latestMessage = await latestAssistant(turnId);
        } catch {
          // Transcript may be briefly unreadable right after a turn; status still stands.
        }
        return {
          sessionId,
          turnId,
          status: ended?.status ?? 'completed',
          latestMessage,
          error: ended?.error,
        };
      }

      const stillBlocked = awaitingApproval();
      if (stillBlocked) return stillBlocked;
    }

    return { sessionId, turnId, status: 'timeout' };
  }

  async steer(_sessionId: string, _text: string): Promise<SteerResult> {
    return {
      sessionId: _sessionId,
      accepted: false,
      error:
        'Claude does not support mid-turn steering. Use interrupt() to stop the current turn, ' +
        'then send_message() with your new instructions.',
    };
  }

  async listApprovals(sessionId: string): Promise<ListApprovalsResult> {
    return {
      sessionId,
      approvals: (this.pendingApprovals.get(sessionId) ?? []).map((p) => p.approval),
    };
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ResolveApprovalResult> {
    const pending = this.pendingApprovals.get(sessionId)?.find((p) => p.approval.id === approvalId);
    if (!pending) {
      return {
        sessionId,
        approvalId,
        resolved: false,
        error: `No pending approval ${approvalId} for session ${sessionId}. Call list_approvals for current IDs.`,
      };
    }
    pending.settle(toPermissionResult(decision, pending));
    return { sessionId, approvalId, resolved: true, decision };
  }

  async setSessionMeta(
    sessionId: string,
    meta: SetSessionMetaOptions,
  ): Promise<SetSessionMetaResult> {
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
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
