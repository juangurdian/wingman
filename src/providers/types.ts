/**
 * Thin provider interface for coding-agent session backends.
 * Codex is first-class; Claude is stubbed.
 */

export type ProviderName = 'codex' | 'claude';

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
  /** User-set tag (discovered sessions). */
  tag?: string;
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

export interface SendMessageResult {
  sessionId: string;
  turnId?: string;
  status: string;
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
}

export interface SessionDetail extends SessionSummary {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
}

export interface SessionProvider {
  readonly name: ProviderName;
  listSessions(): Promise<SessionSummary[]>;
  getSession?(sessionId: string): Promise<SessionDetail | null>;
  readTranscript(sessionId: string, limit?: number): Promise<Transcript>;
  sendMessage(sessionId: string, text: string): Promise<SendMessageResult>;
  interrupt(sessionId: string): Promise<InterruptResult>;
  createSession?(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult>;
}
