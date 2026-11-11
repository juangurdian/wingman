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
 * A resumed query keeps the same session id unless fork_session is set, but it
 * still runs headless: an interactive terminal that already has the session
 * open will not show the turn, and the CLI may fork a new id in that case.
 *
 * Turn budget, permission mode, tool allow and deny lists, and model come from
 * the per-call arguments and WINGMAN_CLAUDE_* defaults. The model is never
 * hardcoded. Omit it to inherit the session model.
 *
 * Mock mode (CLAUDE_MOCK=1):
 * - Returns simulated discovered sessions for testing merge/dedupe without a real Claude install.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  CreateSessionOptions,
  CreateSessionResult,
  InterruptResult,
  ListApprovalsResult,
  ResolveApprovalResult,
  SendMessageOptions,
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
  resolveHostId,
  resolveHostName,
  splitPathList,
} from '../config.js';
import {
  listClaudeLiveSessions,
  sendToClaudeSession as sendToClaudeInbox,
  type ClaudeLiveSession,
} from '../claude-inbox.js';
import { deliverInteractiveInbox, resolveInboxFallback, resolveInboxPickupMs } from '../inbox-pickup.js';
import { ClaudePermissionBroker } from './claude-permissions.js';

const TURN_ALREADY_ACTIVE = 'turn already active; use steer or interrupt';
import {
  buildClaudeQueryOptions,
  ClaudePromptStream,
  extractModelFromSessionMessages,
  readInitModel,
  readMessageSessionId,
  readResultText,
  type ClaudeQueryPlan,
} from './claude-turn.js';

interface WingmanClaudeSession {
  sessionId: string;
  cwd: string;
  name?: string;
  preview?: string;
  tags?: string[];
  /** Last model Wingman passed or observed for this session. */
  model?: string;
  /** Set when this id was created by a fork of another session. */
  forkedFrom?: string;
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
  model?: string;
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  activeTurnId?: string;
}

interface ClaudeQueryLike {
  interrupt(): Promise<unknown>;
  close(): void;
}

interface ActiveTurn {
  turnId: string;
  sessionId: string;
  /** Session id the turn is writing. Differs from the request when the turn forks. */
  actualSessionId?: string;
  startedAt: number;
  /** Prompt text for this turn. Kept off the shell command line. */
  prompt?: string;
  abortController?: AbortController;
  stream?: ClaudePromptStream;
  query?: ClaudeQueryLike;
  plan?: ClaudeQueryPlan;
}

interface TurnOutcome {
  turnId: string;
  status: 'completed' | 'failed' | 'interrupted';
  error?: string;
  latestMessage?: string;
  actualSessionId: string;
  requestedSessionId: string;
  resumeMode: ClaudeQueryPlan['resumeMode'];
  forked: boolean;
  model?: string;
  modelSource: ClaudeQueryPlan['modelSource'];
  attachedToTerminal: false;
  note: string;
}

/** Mock-only marker. A message of this shape pauses the turn on a permission prompt. */
const MOCK_APPROVAL_RE = /^\[approval-request ([A-Za-z0-9_.-]+)\]\s*([\s\S]*)$/;

const NO_ACTIVE_STEER =
  'No active Wingman turn to steer. Use send_message to start a turn, or interrupt and then send_message.';

function useMock(): boolean {
  return process.env.CLAUDE_MOCK === '1' || process.env.CLAUDE_MOCK === 'true';
}

function discoveryEnabled(): boolean {
  const env = process.env.CLAUDE_DISCOVER;
  if (env === '0' || env === 'false') return false;
  return true;
}

function discoverDirs(): string[] | undefined {
  // path.delimiter, not ":", so Windows drive letters in CLAUDE_DISCOVER_DIRS survive.
  return splitPathList(process.env.CLAUDE_DISCOVER_DIRS);
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
  private permissions = new ClaudePermissionBroker();
  private outcomes = new Map<string, TurnOutcome>();
  private prompts = new Map<string, string>();

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

  async listSessions(opts?: { state?: 'live' | 'past' | 'all' }): Promise<SessionSummary[]> {
    const hostId = resolveHostId();
    const hostName = resolveHostName();
    const stateFilter = opts?.state ?? 'all';

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
        live: true,
      }));

      if (!discoveryEnabled()) {
        return this.sortAndFilterByState(wingmanSessions, stateFilter);
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
        live: false,
      }));

      const wingmanIds = new Set(wingmanSessions.map((s) => s.id));
      const merged = [...wingmanSessions];
      for (const ds of discovered) {
        if (!wingmanIds.has(ds.id)) merged.push(ds);
      }
      return this.sortAndFilterByState(merged, stateFilter);
    }

    let liveSessions: ClaudeLiveSession[] = [];
    try {
      liveSessions = await listClaudeLiveSessions();
    } catch {
      liveSessions = [];
    }
    const liveSessionMap = new Map(liveSessions.map((ls) => [ls.sessionId, ls]));

    const registry = loadRegistry();
    const wingmanSessions: SessionSummary[] = registry.sessions.map((reg) => {
      const liveInfo = liveSessionMap.get(reg.sessionId);
      return {
        id: reg.sessionId,
        provider: 'claude' as const,
        cwd: liveInfo?.cwd ?? reg.cwd,
        name: liveInfo?.name ?? reg.name,
        preview: reg.preview,
        status: this.activeTurns.has(reg.sessionId) ? 'running' : 'idle',
        createdAt: reg.createdAt,
        updatedAt: liveInfo?.updatedAt ?? reg.updatedAt,
        source: 'wingman' as const,
        tags: reg.tags,
        hostId,
        hostName,
        model: reg.model,
        live: liveInfo?.live ?? false,
        pid: liveInfo?.pid,
        liveStatus: liveInfo?.status ?? liveInfo?.state,
        kind: liveInfo?.kind,
      };
    });

    const wingmanIds = new Set(wingmanSessions.map((s) => s.id));
    if (!discoveryEnabled()) {
      for (const ls of liveSessions) {
        if (!wingmanIds.has(ls.sessionId)) {
          wingmanSessions.push(this.liveSessionToSummary(ls, hostId, hostName));
        }
      }
      return this.sortAndFilterByState(wingmanSessions, stateFilter);
    }

    const discovered = await this.discoverViaSdk();
    const merged = [...wingmanSessions];
    for (const ds of discovered) {
      if (wingmanIds.has(ds.id)) continue;
      const liveInfo = liveSessionMap.get(ds.id);
      merged.push({
        ...ds,
        hostId,
        hostName,
        live: liveInfo?.live ?? false,
        pid: liveInfo?.pid,
        liveStatus: liveInfo?.status ?? liveInfo?.state,
        kind: liveInfo?.kind,
      });
      wingmanIds.add(ds.id);
    }
    for (const ls of liveSessions) {
      if (!wingmanIds.has(ls.sessionId)) {
        merged.push(this.liveSessionToSummary(ls, hostId, hostName));
      }
    }
    return this.sortAndFilterByState(merged, stateFilter);
  }

  private liveSessionToSummary(
    ls: ClaudeLiveSession,
    hostId: string | undefined,
    hostName: string | undefined,
  ): SessionSummary {
    return {
      id: ls.sessionId,
      provider: 'claude',
      cwd: ls.cwd,
      name: ls.name,
      status: this.activeTurns.has(ls.sessionId) ? 'running' : 'idle',
      updatedAt: ls.updatedAt,
      source: 'discovered',
      hostId,
      hostName,
      live: ls.live ?? false,
      pid: ls.pid,
      liveStatus: ls.status ?? ls.state,
      kind: ls.kind,
    };
  }

  private sortAndFilterByState(
    sessions: SessionSummary[],
    stateFilter: 'live' | 'past' | 'all',
  ): SessionSummary[] {
    let filtered = sessions;
    if (stateFilter === 'live') filtered = sessions.filter((s) => s.live === true);
    else if (stateFilter === 'past') filtered = sessions.filter((s) => s.live !== true);
    filtered.sort((a, b) => {
      if (a.live && !b.live) return -1;
      if (!a.live && b.live) return 1;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
    return filtered;
  }

  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const sessions = await this.listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;

    const activeTurn = this.activeTurns.get(sessionId);
    const hostId = resolveHostId();
    const hostName = resolveHostName();
    const outcome = this.outcomes.get(sessionId);
    const knownModel = this.knownModel(sessionId);
    
    return {
      ...session,
      status: activeTurn ? 'running' : 'idle',
      activeTurnId: activeTurn?.turnId,
      activeTurnStartedAt: activeTurn?.startedAt,
      hostId,
      hostName,
      model: outcome?.model ?? knownModel,
      modelSource: outcome?.modelSource,
      resumeMode: activeTurn?.plan?.resumeMode ?? outcome?.resumeMode,
      requestedSessionId: outcome?.requestedSessionId ?? (activeTurn ? sessionId : undefined),
      actualSessionId: activeTurn?.actualSessionId ?? outcome?.actualSessionId,
      forked: activeTurn
        ? Boolean(
            activeTurn.plan?.forkSession ||
              (activeTurn.actualSessionId !== undefined && activeTurn.actualSessionId !== sessionId),
          )
        : outcome?.forked,
      attachedToTerminal: activeTurn || outcome ? false : undefined,
      note: activeTurn?.plan?.note ?? outcome?.note,
    };
  }

  activity(sessionId: string): import('./types.js').SessionActivity {
    const active = this.activeTurns.get(sessionId);
    const approvals = this.permissions.list(sessionId);
    const outcome = this.outcomes.get(sessionId);
    return {
      running: Boolean(active),
      approvalCount: approvals.length,
      error: !active && outcome?.status === 'failed' ? outcome.error ?? 'turn failed' : undefined,
      prompt: active?.prompt ?? this.prompts.get(sessionId),
      model: active?.plan?.model ?? outcome?.model ?? this.knownModel(sessionId),
      lastActivityAt: active?.startedAt,
      pid: process.pid,
      sharedProcess: true,
    };
  }

  private knownModel(sessionId: string): string | undefined {
    if (useMock()) {
      return (this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId))?.model;
    }
    return loadRegistry().sessions.find((s) => s.sessionId === sessionId)?.model;
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

  async sendMessage(
    sessionId: string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<SendMessageResult> {
    const binding = opts?.binding ?? 'resume';
    if (this.activeTurns.has(sessionId)) {
      throw new Error(TURN_ALREADY_ACTIVE);
    }
    if (useMock()) {
      return this.sendMessageMock(sessionId, text, binding, opts);
    }
    if (binding !== 'new') {
      const delivered = await this.tryInboxDelivery(sessionId, text, opts);
      if (delivered) return delivered;
    }
    const cwd = loadRegistry().sessions.find((s) => s.sessionId === sessionId)?.cwd;
    return this.beginRealTurn(sessionId, text, cwd, binding, opts);
  }

  /**
   * Deliver into a running interactive Claude process.
   * A headless resume runs only when the caller asked for it and the session is idle.
   */
  private async tryInboxDelivery(
    sessionId: string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<SendMessageResult | undefined> {
    try {
      const liveSessions = await listClaudeLiveSessions();
      const liveSession = liveSessions.find((s) => s.sessionId === sessionId);
      if (!liveSession?.live || !liveSession.messagingSocketPath) return undefined;
      const delivery = await deliverInteractiveInbox({
        sessionId,
        beforeStatus: liveSession.status ?? liveSession.state,
        pickupMs: resolveInboxPickupMs(opts?.inboxPickupMs),
        fallback: resolveInboxFallback(opts?.inboxFallback),
        send: async () => {
          const inboxResult = await sendToClaudeInbox(sessionId, text);
          return { delivered: inboxResult.delivered, error: inboxResult.error };
        },
        list: async () => {
          const again = await listClaudeLiveSessions();
          return again.map((session) => ({
            sessionId: session.sessionId,
            status: session.status,
            state: session.state,
          }));
        },
      });
      if (delivery.headless) {
        console.warn(`[claude] ${delivery.result.note ?? 'Falling back to a headless resume.'}`);
        return undefined;
      }
      return delivery.result;
    } catch (err) {
      console.warn(`[claude] Live session check failed: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }

  private sendMessageMock(
    sessionId: string,
    text: string,
    binding: 'new' | 'resume',
    opts?: SendMessageOptions,
  ): SendMessageResult {
    const requested = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
    if (!requested) throw new Error(`Unknown mock session: ${sessionId}`);
    if (this.activeTurns.has(sessionId) || this.activeTurns.has(requested.id)) {
      throw new Error(TURN_ALREADY_ACTIVE);
    }

    const plan = buildClaudeQueryOptions({
      binding,
      sessionId,
      cwd: requested.cwd,
      turn: { ...opts, binding },
      sessionModel: binding === 'resume' ? requested.model : undefined,
    });

    const target =
      plan.resumeMode === 'fork' ? this.cloneMock(requested) : requested;
    if (plan.model) target.model = plan.model;

    const turnId = `turn_mock_${randomUUID().slice(0, 8)}`;
    const abortController = new AbortController();
    const activeTurn: ActiveTurn = {
      turnId,
      sessionId: target.id,
      actualSessionId: target.id,
      startedAt: Date.now(),
      prompt: text,
      abortController,
      plan,
    };
    this.prompts.set(sessionId, text);
    this.prompts.set(target.id, text);
    this.activeTurns.set(sessionId, activeTurn);
    if (target.id !== sessionId) this.activeTurns.set(target.id, activeTurn);
    target.activeTurnId = turnId;
    target.items.push({ role: 'user', text, turnId });

    void this.finishMockTurn(target, sessionId, text, turnId, abortController, plan, opts);

    return this.acceptedResult(sessionId, target.id, turnId, plan);
  }

  private async finishMockTurn(
    target: MockDiscoveredSession,
    requestedSessionId: string,
    text: string,
    turnId: string,
    abortController: AbortController,
    plan: ClaudeQueryPlan,
    opts?: SendMessageOptions,
  ): Promise<void> {
    let status: TurnOutcome['status'] = 'completed';
    let latestMessage: string | undefined;
    const approval = text.match(MOCK_APPROVAL_RE);
    try {
      if (approval) {
        const toolName = approval[1] ?? 'Bash';
        const rest = (approval[2] ?? '').trim();
        const input: Record<string, unknown> =
          toolName.toLowerCase() === 'bash' || toolName.toLowerCase() === 'powershell'
            ? { command: rest || 'mock-command' }
            : { file_path: rest || 'mock.txt' };
        const decision = await this.permissions.request({
          toolName,
          input,
          sessionId: requestedSessionId,
          turnId,
          signal: abortController.signal,
          timeoutMs: opts?.approvalTimeoutMs,
          title: `Claude wants to use ${toolName}`,
        });
        if (abortController.signal.aborted) {
          status = 'interrupted';
          return;
        }
        latestMessage =
          decision.behavior === 'deny'
            ? `[mock Claude] Denied: ${decision.message ?? 'denied'}`
            : `[mock Claude] Approved ${toolName}`;
        target.items.push({ role: 'assistant', text: latestMessage, turnId });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (
          abortController.signal.aborted ||
          this.activeTurns.get(requestedSessionId)?.turnId !== turnId
        ) {
          status = 'interrupted';
          return;
        }
        const steers = target.items
          .filter((item) => item.turnId === turnId && item.text.startsWith('[steer] '))
          .map((item) => item.text.slice('[steer] '.length));
        latestMessage = `[mock Claude] Received: ${text}`;
        if (steers.length > 0) latestMessage += ` | steer: ${steers.join('; ')}`;
        target.items.push({ role: 'assistant', text: latestMessage, turnId });
      }
    } finally {
      target.preview = text.slice(0, 80);
      target.updatedAt = Date.now();
      if (target.activeTurnId === turnId) target.activeTurnId = undefined;
      const outcome = this.makeOutcome(requestedSessionId, target.id, turnId, plan, status, latestMessage);
      this.settleTurn(requestedSessionId, turnId, outcome);
      if (target.id !== requestedSessionId) this.settleTurn(target.id, turnId, outcome);
    }
  }

  private cloneMock(source: MockDiscoveredSession): MockDiscoveredSession {
    const copy: MockDiscoveredSession = {
      ...source,
      id: randomUUID(),
      items: source.items.map((item) => ({ ...item })),
      activeTurnId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.mockSessions.set(copy.id, copy);
    return copy;
  }

  private beginRealTurn(
    sessionId: string,
    text: string,
    cwd: string | undefined,
    binding: 'new' | 'resume',
    opts?: SendMessageOptions,
  ): SendMessageResult {
    if (this.activeTurns.has(sessionId)) {
      throw new Error(TURN_ALREADY_ACTIVE);
    }
    const plan = buildClaudeQueryOptions({
      binding,
      sessionId,
      cwd,
      turn: { ...opts, binding },
      sessionModel: binding === 'resume' ? this.knownModel(sessionId) : undefined,
    });
    const turnId = `turn_${randomUUID().slice(0, 8)}`;
    const stream = new ClaudePromptStream();
    stream.push(text);
    const abortController = new AbortController();
    const activeTurn: ActiveTurn = {
      turnId,
      sessionId,
      actualSessionId: sessionId,
      startedAt: Date.now(),
      prompt: text,
      abortController,
      stream,
      plan,
    };
    this.prompts.set(sessionId, text);
    this.activeTurns.set(sessionId, activeTurn);

    void this.runQuery({
      sessionId,
      text,
      cwd,
      binding,
      opts,
      activeTurn,
      stream,
      plan,
    }).catch((err) => {
      console.error(`[claude] Background turn error for ${sessionId}:`, err);
    });

    return this.acceptedResult(sessionId, sessionId, turnId, plan);
  }

  private async runQuery(args: {
    sessionId: string;
    text: string;
    cwd: string | undefined;
    binding: 'new' | 'resume';
    opts?: SendMessageOptions;
    activeTurn: ActiveTurn;
    stream: ClaudePromptStream;
    plan: ClaudeQueryPlan;
  }): Promise<void> {
    const { sessionId, text, cwd, binding, opts, activeTurn, stream } = args;
    let plan = args.plan;
    let actualSessionId = sessionId;
    let observedModel: string | undefined;
    let latestMessage: string | undefined;
    let outcomeStatus: TurnOutcome['status'] = 'completed';
    let error: string | undefined;

    try {
      if (binding === 'resume' && plan.modelSource === 'cli-default') {
        const sessionModel = await this.lookupSessionModel(sessionId, cwd);
        if (sessionModel) {
          plan = buildClaudeQueryOptions({
            binding,
            sessionId,
            cwd,
            turn: { ...opts, binding },
            sessionModel,
          });
          activeTurn.plan = plan;
        }
      }

      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const abortController = activeTurn.abortController ?? new AbortController();
      activeTurn.abortController = abortController;

      const queryGen = sdk.query({
        prompt: stream.iterate(),
        options: {
          ...plan.options,
          abortController,
          canUseTool: (toolName, input, sdkOptions) =>
            this.permissions.request({
              toolName,
              input,
              sessionId,
              turnId: activeTurn.turnId,
              signal: sdkOptions.signal,
              suggestions: sdkOptions.suggestions,
              title: sdkOptions.title,
              description: sdkOptions.description,
              decisionReason: sdkOptions.decisionReason,
              blockedPath: sdkOptions.blockedPath,
              toolUseID: sdkOptions.toolUseID,
              timeoutMs: opts?.approvalTimeoutMs,
            }),
          // sessionId is a UUID from randomUUID(); the SDK brands that string.
        } as NonNullable<Parameters<typeof sdk.query>[0]['options']>,
      });
      activeTurn.query = queryGen;

      for await (const msg of queryGen) {
        if (abortController.signal.aborted) {
          outcomeStatus = 'interrupted';
          break;
        }
        const reportedSessionId = readMessageSessionId(msg);
        if (reportedSessionId) {
          actualSessionId = reportedSessionId;
          activeTurn.actualSessionId = reportedSessionId;
          if (reportedSessionId !== sessionId) this.activeTurns.set(reportedSessionId, activeTurn);
        }
        const initModel = readInitModel(msg);
        if (initModel) observedModel = initModel;
        const result = readResultText(msg);
        if (!result) continue;
        if (result.text) latestMessage = result.text;
        if (result.failed) {
          outcomeStatus = 'failed';
          error = result.error;
        }
        if (stream.queued === 0) stream.finish();
      }
    } catch (err) {
      if (activeTurn.abortController?.signal.aborted) {
        outcomeStatus = 'interrupted';
      } else {
        outcomeStatus = 'failed';
        error = err instanceof Error ? err.message : String(err);
        console.error(`[claude] Background turn error for ${sessionId}:`, err);
      }
    } finally {
      stream.finish();
      try {
        activeTurn.query?.close();
      } catch {
        /* query already closed */
      }
      this.permissions.cancelSession(sessionId, 'Turn ended before approval.', activeTurn.turnId);
      if (activeTurn.abortController?.signal.aborted) outcomeStatus = 'interrupted';

      const model = observedModel ?? plan.model;
      const forked = plan.forkSession || actualSessionId !== sessionId;
      const resumeMode = forked && binding === 'resume' ? 'fork' : plan.resumeMode;
      const outcome = this.makeOutcome(
        sessionId,
        actualSessionId,
        activeTurn.turnId,
        { ...plan, resumeMode, forkSession: forked },
        outcomeStatus,
        latestMessage,
        error,
        model,
      );
      const stillOwns = this.settleTurn(sessionId, activeTurn.turnId, outcome);
      if (actualSessionId !== sessionId) this.settleTurn(actualSessionId, activeTurn.turnId, outcome);
      if (stillOwns) await this.persistTurn(sessionId, actualSessionId, cwd, text, model);
    }
  }

  /**
   * Publish a turn outcome only while this turn still owns the slot.
   * A newer turn keeps its entry and its approvals. An interrupted turn with
   * no replacement still records its outcome.
   */
  private settleTurn(sessionId: string, turnId: string, outcome: TurnOutcome): boolean {
    const current = this.activeTurns.get(sessionId);
    if (current && current.turnId !== turnId) return false;
    this.outcomes.set(sessionId, outcome);
    if (current?.turnId === turnId) this.activeTurns.delete(sessionId);
    return true;
  }

  private async lookupSessionModel(sessionId: string, cwd?: string): Promise<string | undefined> {
    const known = this.knownModel(sessionId);
    if (known) return known;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const messages = await sdk.getSessionMessages(sessionId, { dir: cwd, limit: 40 });
      return extractModelFromSessionMessages(messages);
    } catch {
      return undefined;
    }
  }

  private async persistTurn(
    sessionId: string,
    actualSessionId: string,
    cwd: string | undefined,
    text: string,
    model: string | undefined,
  ): Promise<void> {
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const registry = loadRegistry();
      const session = registry.sessions.find((s) => s.sessionId === sessionId);
      if (!session) {
        const info = await sdk.getSessionInfo(sessionId);
        if (info) {
          registerSession({
            sessionId,
            cwd: info.cwd ?? cwd ?? process.cwd(),
            name: info.customTitle ?? info.summary,
            preview: text.slice(0, 80),
            model,
            createdAt: info.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        }
      } else {
        if (model) session.model = model;
        session.preview = text.slice(0, 80);
        session.updatedAt = Date.now();
        saveRegistry(registry);
      }

      if (actualSessionId !== sessionId) {
        const again = loadRegistry();
        if (!again.sessions.some((s) => s.sessionId === actualSessionId)) {
          registerSession({
            sessionId: actualSessionId,
            cwd: cwd ?? process.cwd(),
            name: `Fork of ${sessionId.slice(0, 8)}`,
            preview: text.slice(0, 80),
            model,
            forkedFrom: sessionId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      }
    } catch (err) {
      console.error(`[claude] Failed to persist session ${sessionId}:`, err);
    }
  }

  private acceptedResult(
    requestedSessionId: string,
    actualSessionId: string,
    turnId: string,
    plan: ClaudeQueryPlan,
  ): SendMessageResult {
    return {
      sessionId: requestedSessionId,
      requestedSessionId,
      actualSessionId,
      turnId,
      status: 'accepted',
      resumeMode: plan.resumeMode,
      forked: plan.forkSession || actualSessionId !== requestedSessionId,
      attachedToTerminal: false,
      model: plan.model,
      modelSource: plan.modelSource,
      maxTurns: plan.maxTurns,
      permissionMode: plan.permissionMode,
      note: plan.note,
    };
  }

  private makeOutcome(
    requestedSessionId: string,
    actualSessionId: string,
    turnId: string,
    plan: ClaudeQueryPlan,
    status: TurnOutcome['status'],
    latestMessage?: string,
    error?: string,
    model?: string,
  ): TurnOutcome {
    const forked = plan.forkSession || actualSessionId !== requestedSessionId;
    return {
      turnId,
      status,
      error,
      latestMessage,
      actualSessionId,
      requestedSessionId,
      resumeMode: forked && plan.resumeMode !== 'new' ? 'fork' : plan.resumeMode,
      forked,
      model: model ?? plan.model,
      modelSource: !plan.model && model ? 'session' : plan.modelSource,
      attachedToTerminal: false,
      note: plan.note,
    };
  }

  async interrupt(sessionId: string): Promise<InterruptResult> {
    if (useMock()) {
      const activeTurn = this.activeTurns.get(sessionId);
      const mock =
        this.mockSessions.get(sessionId) ??
        this.mockDiscovered.get(sessionId) ??
        (activeTurn
          ? this.mockSessions.get(activeTurn.sessionId) ??
            this.mockDiscovered.get(activeTurn.sessionId)
          : undefined);
      if (!mock) throw new Error(`Unknown mock session: ${sessionId}`);

      const turnId = activeTurn?.turnId ?? mock.activeTurnId;
      if (activeTurn) {
        activeTurn.abortController?.abort();
        activeTurn.stream?.finish();
        this.permissions.cancelSession(sessionId, 'Turn interrupted before approval.', activeTurn.turnId);
        this.activeTurns.delete(sessionId);
        if (activeTurn.sessionId !== sessionId) this.activeTurns.delete(activeTurn.sessionId);
      }
      mock.activeTurnId = undefined;
      mock.items.push({
        role: 'system',
        text: '[mock] Interrupted',
        turnId,
      });
      return { sessionId, turnId, status: 'interrupted' };
    }

    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) {
      return { sessionId, turnId: undefined, status: 'no_active_turn' };
    }

    activeTurn.abortController?.abort();
    activeTurn.stream?.finish();
    this.permissions.cancelSession(sessionId, 'Turn interrupted before approval.', activeTurn.turnId);
    try {
      await activeTurn.query?.interrupt();
    } catch {
      /* The CLI process may already have exited. */
    }
    try {
      activeTurn.query?.close();
    } catch {
      /* already closed */
    }

    const plan = activeTurn.plan;
    this.outcomes.set(sessionId, {
      turnId: activeTurn.turnId,
      status: 'interrupted',
      actualSessionId: sessionId,
      requestedSessionId: sessionId,
      resumeMode: plan?.resumeMode ?? 'resume',
      forked: plan?.forkSession ?? false,
      model: plan?.model,
      modelSource: plan?.modelSource ?? 'cli-default',
      attachedToTerminal: false,
      note: plan?.note ?? '',
    });
    this.activeTurns.delete(sessionId);

    return { sessionId, turnId: activeTurn.turnId, status: 'interrupted' };
  }

  async createSession(opts?: CreateSessionOptions): Promise<CreateSessionResult> {
    if (useMock()) {
      const s = this.seedMock({
        cwd: opts?.cwd ?? process.cwd(),
        name: opts?.name ?? 'mock-claude-created',
        preview: opts?.prompt?.slice(0, 80),
        tags: opts?.tags,
      });
      const plan = buildClaudeQueryOptions({
        binding: 'new',
        sessionId: s.id,
        cwd: s.cwd,
        turn: opts,
      });
      if (plan.model) s.model = plan.model;

      if (opts?.prompt) {
        const sendResult = await this.sendMessage(s.id, opts.prompt, { ...opts, binding: 'new' });
        return {
          sessionId: s.id,
          provider: 'claude',
          cwd: s.cwd,
          status: 'accepted',
          turnId: sendResult.turnId,
          model: sendResult.model,
          modelSource: sendResult.modelSource,
          resumeMode: 'new',
          attachedToTerminal: false,
          maxTurns: sendResult.maxTurns,
          permissionMode: sendResult.permissionMode,
          note: sendResult.note,
        };
      }

      return {
        sessionId: s.id,
        provider: 'claude',
        cwd: s.cwd,
        status: 'created',
        model: plan.model,
        modelSource: plan.modelSource,
        resumeMode: 'new',
        attachedToTerminal: false,
        maxTurns: plan.maxTurns,
        permissionMode: plan.permissionMode,
        note: plan.note,
      };
    }

    try {
      const sessionId: string = randomUUID();
      const now = Date.now();
      const cwd = opts?.cwd ?? process.cwd();
      const plan = buildClaudeQueryOptions({
        binding: 'new',
        sessionId,
        cwd,
        turn: opts,
      });

      registerSession({
        sessionId,
        cwd,
        name: opts?.name ?? opts?.prompt?.slice(0, 40) ?? 'Wingman session',
        preview: opts?.prompt?.slice(0, 80),
        tags: opts?.tags,
        model: plan.model,
        createdAt: now,
        updatedAt: now,
      });

      if (opts?.prompt) {
        const sendResult = this.beginRealTurn(sessionId, opts.prompt, cwd, 'new', opts);
        return {
          sessionId,
          provider: 'claude',
          cwd,
          status: 'accepted',
          turnId: sendResult.turnId,
          model: sendResult.model,
          modelSource: sendResult.modelSource,
          resumeMode: 'new',
          attachedToTerminal: false,
          maxTurns: sendResult.maxTurns,
          permissionMode: sendResult.permissionMode,
          note: sendResult.note,
        };
      }

      return {
        sessionId,
        provider: 'claude',
        cwd,
        status: 'created',
        model: plan.model,
        modelSource: plan.modelSource,
        resumeMode: 'new',
        attachedToTerminal: false,
        maxTurns: plan.maxTurns,
        permissionMode: plan.permissionMode,
        note: plan.note,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create Claude session: ${msg}`);
    }
  }

  async waitTurn(sessionId: string, opts?: WaitTurnOptions): Promise<WaitTurnResult> {
    const timeoutMs = opts?.timeoutMs ?? resolveWaitTurnTimeoutMs();
    const pollIntervalMs = opts?.pollIntervalMs ?? 500;

    if (useMock()) {
      const mock = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
      const active = this.activeTurns.get(sessionId);
      const target = mock ?? (active
        ? this.mockSessions.get(active.sessionId) ?? this.mockDiscovered.get(active.sessionId)
        : undefined);
      if (!target && !mock) throw new Error(`Unknown mock session: ${sessionId}`);

      const activeTurn = this.activeTurns.get(sessionId);
      if (!activeTurn) {
        return this.idleWait(sessionId, target?.items ?? mock?.items ?? []);
      }

      const pendingNow = this.pendingWait(sessionId, activeTurn);
      if (pendingNow) return pendingNow;

      const turnId = activeTurn.turnId;
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        const pending = this.pendingWait(sessionId, activeTurn);
        if (pending) return pending;

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        const currentTurn = this.activeTurns.get(sessionId);
        if (!currentTurn || currentTurn.turnId !== turnId) {
          return this.finishedWait(sessionId, turnId, target?.items ?? mock?.items ?? []);
        }
      }

      return { sessionId, turnId, status: 'timeout', attachedToTerminal: false, note: activeTurn.plan?.note };
    }

    const activeTurn = this.activeTurns.get(sessionId);
    if (!activeTurn) {
      return this.idleWait(sessionId);
    }

    const pendingNow = this.pendingWait(sessionId, activeTurn);
    if (pendingNow) return pendingNow;

    const turnId = activeTurn.turnId;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const pending = this.pendingWait(sessionId, activeTurn);
      if (pending) return pending;

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnId !== turnId) {
        let latest: string | undefined;
        try {
          const transcript = await this.readTranscript(sessionId, 10);
          latest = [...transcript.items].reverse().find((item) => item.role === 'assistant')?.text;
        } catch {
          latest = undefined;
        }
        return this.finishedWait(sessionId, turnId, undefined, latest);
      }
    }

    return {
      sessionId,
      turnId,
      status: 'timeout',
      attachedToTerminal: false,
      note: activeTurn.plan?.note,
    };
  }

  private pendingWait(sessionId: string, activeTurn: ActiveTurn): WaitTurnResult | undefined {
    const approvals = this.permissions.list(sessionId);
    if (approvals.length === 0) return undefined;
    return {
      sessionId,
      turnId: activeTurn.turnId,
      status: 'inProgress',
      latestMessage: `Waiting for ${approvals.length} approval(s)`,
      attachedToTerminal: false,
      resumeMode: activeTurn.plan?.resumeMode,
      note: activeTurn.plan?.note,
    };
  }

  private idleWait(sessionId: string, items?: TranscriptItem[]): WaitTurnResult {
    const outcome = this.outcomes.get(sessionId);
    const lastAssistant = items
      ? [...items].reverse().find((item) => item.role === 'assistant')
      : undefined;
    return {
      sessionId,
      status: 'idle',
      latestMessage: lastAssistant?.text?.slice(0, 200) ?? outcome?.latestMessage?.slice(0, 200),
      actualSessionId: outcome?.actualSessionId,
      resumeMode: outcome?.resumeMode,
      forked: outcome?.forked,
      attachedToTerminal: outcome ? false : undefined,
      model: outcome?.model,
      note: outcome?.note,
    };
  }

  private finishedWait(
    sessionId: string,
    turnId: string,
    items?: TranscriptItem[],
    fallbackLatest?: string,
  ): WaitTurnResult {
    const outcome = this.outcomes.get(sessionId);
    const matched = outcome?.turnId === turnId ? outcome : undefined;
    const lastAssistant = items
      ? [...items].reverse().find((item) => item.role === 'assistant' && item.turnId === turnId)
      : undefined;
    return {
      sessionId,
      turnId,
      status: matched?.status ?? 'completed',
      latestMessage: (lastAssistant?.text ?? matched?.latestMessage ?? fallbackLatest)?.slice(0, 200),
      error: matched?.error,
      actualSessionId: matched?.actualSessionId,
      resumeMode: matched?.resumeMode,
      forked: matched?.forked,
      attachedToTerminal: false,
      model: matched?.model,
      note: matched?.note,
    };
  }

  async steer(sessionId: string, text: string): Promise<SteerResult> {
    const activeTurn = this.activeTurns.get(sessionId);
    if (useMock()) {
      const mock = this.mockSessions.get(sessionId) ?? this.mockDiscovered.get(sessionId);
      const target = activeTurn
        ? this.mockSessions.get(activeTurn.sessionId) ??
          this.mockDiscovered.get(activeTurn.sessionId) ??
          mock
        : mock;
      if (!target && !mock) throw new Error(`Unknown mock session: ${sessionId}`);
      if (!activeTurn) {
        return { sessionId, accepted: false, error: NO_ACTIVE_STEER };
      }
      (target ?? mock)?.items.push({
        role: 'user',
        text: `[steer] ${text}`,
        turnId: activeTurn.turnId,
      });
      return { sessionId, turnId: activeTurn.turnId, accepted: true };
    }

    if (!activeTurn?.stream || activeTurn.stream.isFinished) {
      return { sessionId, accepted: false, error: NO_ACTIVE_STEER };
    }
    const accepted = activeTurn.stream.push(text, 'now');
    if (!accepted) {
      return {
        sessionId,
        turnId: activeTurn.turnId,
        accepted: false,
        error: 'Turn is already finishing. Use send_message for a new turn.',
      };
    }
    return { sessionId, turnId: activeTurn.turnId, accepted: true };
  }

  async listApprovals(sessionId: string): Promise<ListApprovalsResult> {
    return { sessionId, approvals: this.permissions.list(sessionId) };
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ResolveApprovalResult> {
    return this.permissions.resolve(sessionId, approvalId, decision);
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
