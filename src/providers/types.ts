/**
 * Thin provider interface for coding-agent session backends.
 * Codex, Claude Code, and Muse each implement the same session tools.
 */

export type ProviderName = 'codex' | 'claude' | 'muse';

export type SessionSource = 'wingman' | 'discovered';

export interface SessionSummary {
  id: string;
  provider: ProviderName;
  cwd?: string;
  preview?: string;
  name?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Origin of this session: 'wingman' = created via Wingman, 'discovered' = found via SDK/disk. */
  source?: SessionSource;
  /** Git branch at end of session (discovered sessions). */
  gitBranch?: string;
  /** User-set tag (discovered sessions - legacy single tag). */
  tag?: string;
  /** User-set tags for categorization/filtering. */
  tags?: string[];
  /** Host identifier for multi-host setups. */
  hostId?: string;
  /** Human-friendly host name for display. */
  hostName?: string;
}

export interface TranscriptItem {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'unknown';
  text: string;
  turnId?: string;
  itemId?: string;
  type?: string;
}

export interface Transcript {
  sessionId: string;
  provider: ProviderName;
  items: TranscriptItem[];
}

export type ClaudeResumeMode = 'new' | 'resume' | 'fork';

export type ClaudeModelSource = 'call' | 'env' | 'session' | 'cli-default';

export interface SendMessageResult {
  sessionId: string;
  turnId?: string;
  status: string;
  /**
   * How this turn was bound. `resume` keeps the requested session id,
   * `fork` copies it, `new` starts one. The CLI can still fork a resume
   * when an interactive terminal holds the session; see `actualSessionId`.
   */
  resumeMode?: ClaudeResumeMode;
  /** Session id the caller addressed. */
  requestedSessionId?: string;
  /** Session id the CLI is actually writing, once known. */
  actualSessionId?: string;
  /** True when the caller asked to fork, or the CLI id differs from the request. */
  forked?: boolean;
  /** Headless queries do not attach to an open interactive terminal. */
  attachedToTerminal?: boolean;
  model?: string;
  modelSource?: ClaudeModelSource;
  maxTurns?: number;
  permissionMode?: string;
  /** Plain-language resume/fork and terminal-visibility note. */
  note?: string;
}

export interface InterruptResult {
  sessionId: string;
  turnId?: string;
  status: string;
}

export interface CreateSessionResult {
  sessionId: string;
  provider: ProviderName;
  cwd?: string;
  /** Status: 'created' (no prompt), 'accepted' (prompt started in background) */
  status?: 'created' | 'accepted';
  /** Turn ID when prompt is provided and status is 'accepted' */
  turnId?: string;
  /**
   * Model used for the session.
   * Codex: explicit arg or WINGMAN_CODEX_MODEL.
   * Claude: explicit arg, WINGMAN_CLAUDE_MODEL, or omitted so Claude Code picks.
   */
  model?: string;
  modelSource?: ClaudeModelSource;
  resumeMode?: ClaudeResumeMode;
  attachedToTerminal?: boolean;
  maxTurns?: number;
  permissionMode?: string;
  note?: string;
}

export interface SessionDetail extends SessionSummary {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  /** User-set tags for categorization/filtering. */
  tags?: string[];
  /** Model Wingman last observed or requested for this session. */
  model?: string;
  modelSource?: ClaudeModelSource;
  resumeMode?: ClaudeResumeMode;
  requestedSessionId?: string;
  actualSessionId?: string;
  forked?: boolean;
  /** False for headless Claude queries. They do not appear in an open terminal. */
  attachedToTerminal?: boolean;
  note?: string;
}

export interface WaitTurnOptions {
  /** Maximum time to wait in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** Poll interval in milliseconds for checking turn status (default: 500) */
  pollIntervalMs?: number;
}

export interface WaitTurnResult {
  sessionId: string;
  turnId?: string;
  /**
   * Final status. `inProgress` means the turn is still running, often because
   * a permission prompt is waiting on list_approvals / resolve_approval.
   */
  status: 'completed' | 'interrupted' | 'failed' | 'timeout' | 'idle' | 'inProgress';
  /** Snippet of the latest agent message if available */
  latestMessage?: string;
  /** Error message if status is 'failed' */
  error?: string;
  resumeMode?: ClaudeResumeMode;
  actualSessionId?: string;
  forked?: boolean;
  attachedToTerminal?: boolean;
  model?: string;
  note?: string;
}

export interface SteerResult {
  sessionId: string;
  turnId?: string;
  /** Whether the steer was accepted */
  accepted: boolean;
  /** Error message if not accepted */
  error?: string;
}

export type ApprovalKind = 'command' | 'fileChange' | 'network' | 'writeStdin';
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface Approval {
  /** Unique approval ID */
  id: string;
  /** Session ID this approval belongs to */
  sessionId: string;
  /** Turn ID this approval belongs to */
  turnId?: string;
  /** Item ID if associated with an item */
  itemId?: string;
  /** Kind of approval request */
  kind: ApprovalKind;
  /** Command to execute (for command approvals) */
  command?: string;
  /** Working directory (for command approvals) */
  cwd?: string;
  /** Description / reason for the approval */
  reason?: string;
  /** Claude tool name when the prompt came from canUseTool. */
  toolName?: string;
  /** Timestamp when approval was requested */
  requestedAt: number;
}

export interface ListApprovalsResult {
  sessionId: string;
  approvals: Approval[];
}

export interface ResolveApprovalResult {
  sessionId: string;
  approvalId: string;
  /** Whether the resolution was applied */
  resolved: boolean;
  /** Decision that was applied */
  decision?: ApprovalDecision;
  /** Error message if not resolved */
  error?: string;
}

export interface SetSessionMetaOptions {
  /** Human-friendly name for the session */
  name?: string;
  /** Tags for categorization/filtering */
  tags?: string[];
}

export interface SetSessionMetaResult {
  sessionId: string;
  /** Whether the metadata was updated */
  updated: boolean;
  /** Current name after update */
  name?: string;
  /** Current tags after update */
  tags?: string[];
  /** Error message if not updated */
  error?: string;
}

export interface CreateSessionOptions {
  cwd?: string;
  prompt?: string;
  name?: string;
  tags?: string[];
  /**
   * Model override.
   * Codex: optional; defaults to Codex config.
   * Claude: optional; when omitted, a new session uses Claude Code's default
   * and a later send_message inherits the session model.
   */
  model?: string;
  /** Claude agent-turn budget for the initial prompt. Default 50. */
  maxTurns?: number;
  /** Claude permission mode for the initial prompt. Default "default". */
  permissionMode?: string;
  /** Claude tools that skip the permission prompt. */
  allowedTools?: string[];
  /** Claude tools removed from the session. */
  disallowedTools?: string[];
  /** Claude: deny an unanswered permission prompt after this many milliseconds. */
  approvalTimeoutMs?: number;
}

export interface SendMessageOptions {
  /** Claude agent-turn budget. Default 50. Ignored by Codex. */
  maxTurns?: number;
  /** Claude permission mode. Default "default". Ignored by Codex. */
  permissionMode?: string;
  /** Claude tools that skip the permission prompt. */
  allowedTools?: string[];
  /** Claude tools removed from the session. */
  disallowedTools?: string[];
  /**
   * Model override for this Claude turn.
   * Omit to inherit the session model (or Claude Code's default when none is known).
   */
  model?: string;
  /** Claude: true copies the session onto a new id. Default false resumes the same id. */
  forkSession?: boolean;
  /** Claude: deny an unanswered permission prompt after this many milliseconds. */
  approvalTimeoutMs?: number;
  /** Internal. create_session's first prompt is a new session, not a resume. */
  binding?: 'new' | 'resume';
}

export interface SessionProvider {
  readonly name: ProviderName;
  listSessions(): Promise<SessionSummary[]>;
  getSession?(sessionId: string): Promise<SessionDetail | null>;
  readTranscript(sessionId: string, limit?: number): Promise<Transcript>;
  sendMessage(sessionId: string, text: string, opts?: SendMessageOptions): Promise<SendMessageResult>;
  interrupt(sessionId: string): Promise<InterruptResult>;
  createSession?(opts?: CreateSessionOptions): Promise<CreateSessionResult>;
  
  /** Wait for an active turn to complete, or to pause on a permission prompt. */
  waitTurn?(sessionId: string, opts?: WaitTurnOptions): Promise<WaitTurnResult>;
  /**
   * Add guidance to an in-flight turn without starting a new turn.
   * Codex uses turn/steer. Claude queues a user message on the headless query.
   */
  steer?(sessionId: string, text: string): Promise<SteerResult>;
  /** List pending approvals for a session. */
  listApprovals?(sessionId: string): Promise<ListApprovalsResult>;
  /** Resolve a pending approval. */
  resolveApproval?(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<ResolveApprovalResult>;
  /** Set session metadata (name, tags) for easier discovery */
  setSessionMeta?(sessionId: string, meta: SetSessionMetaOptions): Promise<SetSessionMetaResult>;
}
