/**
 * Thin provider interface for coding-agent session backends.
 * Codex is first-class; Claude is stubbed.
 */

export type ProviderName = 'codex' | 'claude';

export interface SessionSummary {
  id: string;
  provider: ProviderName;
  cwd?: string;
  preview?: string;
  name?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
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

export interface SessionProvider {
  readonly name: ProviderName;
  listSessions(): Promise<SessionSummary[]>;
  readTranscript(sessionId: string, limit?: number): Promise<Transcript>;
  sendMessage(sessionId: string, text: string): Promise<SendMessageResult>;
  interrupt(sessionId: string): Promise<InterruptResult>;
  createSession?(opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult>;
}
