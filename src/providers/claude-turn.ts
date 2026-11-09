/**
 * Pure helpers for Claude Agent SDK query options.
 * Kept free of the SDK runtime so tests can lock the turn contract
 * without spawning Claude Code.
 */

import {
  resolveClaudeMaxTurns,
  resolveClaudeModelOverride,
  resolveClaudePermissionMode,
  resolveClaudeToolList,
  type ClaudePermissionMode,
} from '../config.js';
import type { ClaudeModelSource, ClaudeResumeMode, SendMessageOptions } from './types.js';

export type { ClaudeModelSource, ClaudeResumeMode };

/** Per-call Claude turn settings. Same shape as send_message / create_session options. */
export type ClaudeTurnOptions = SendMessageOptions;

export interface ClaudeQueryOptionBag {
  cwd?: string;
  maxTurns: number;
  permissionMode: ClaudePermissionMode;
  /** Host answers prompts through canUseTool. `none` would auto-deny them. */
  permissionPrompts: 'host';
  resume?: string;
  sessionId?: string;
  forkSession?: boolean;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowDangerouslySkipPermissions?: boolean;
}

export interface ClaudeQueryPlan {
  resumeMode: ClaudeResumeMode;
  forkSession: boolean;
  maxTurns: number;
  permissionMode: ClaudePermissionMode;
  model?: string;
  modelSource: ClaudeModelSource;
  allowedTools?: string[];
  disallowedTools?: string[];
  options: ClaudeQueryOptionBag;
  note: string;
}

export interface BuildClaudeQueryOptionsInput {
  binding: 'new' | 'resume';
  sessionId?: string;
  cwd?: string;
  turn?: ClaudeTurnOptions;
  /** Model already stored for this session, if Wingman has seen one. */
  sessionModel?: string;
  /** Test seam. Production reads WINGMAN_CLAUDE_MODEL. */
  envModel?: string;
}

/**
 * Headless resume limit. The Agent SDK starts a separate CLI process.
 * It cannot type into, or live-update, an interactive Claude Code terminal
 * that already has the session open. The CLI may also fork a new session id
 * when that terminal holds the transcript.
 */
export const CLAUDE_HEADLESS_NOTE =
  'A headless Agent SDK query is not shown in an already-open interactive Claude Code terminal. ' +
  'It updates the session file on disk (or a forked copy of it) and does not attach to that terminal.';

export function claudeTurnNote(resumeMode: ClaudeResumeMode): string {
  if (resumeMode === 'fork') {
    return (
      'fork_session is true, so this turn copies the conversation onto a new session id. ' +
      'The original session is left unchanged. ' +
      CLAUDE_HEADLESS_NOTE
    );
  }
  if (resumeMode === 'resume') {
    return (
      'Resuming the same session id with forkSession false. ' +
      'If an interactive Claude Code terminal already has this session open, the CLI may still ' +
      'fork a new id; actualSessionId on get_session and wait_turn is the id the CLI used. ' +
      CLAUDE_HEADLESS_NOTE
    );
  }
  return `Starting a new headless session. ${CLAUDE_HEADLESS_NOTE}`;
}

/**
 * Model selection. Never invents a model id.
 * Priority: per-call model > WINGMAN_CLAUDE_MODEL > session model > omit
 * (Claude Code's own default for a new session, or whatever the CLI keeps
 * when resume is given no model flag).
 *
 * Passing the session model on resume avoids the headless CLI falling
 * through to its default model instead of the model the session was using.
 */
export function resolveClaudeTurnModel(input: {
  explicit?: string;
  envModel?: string;
  sessionModel?: string;
}): { model?: string; modelSource: ClaudeModelSource } {
  if (input.explicit?.trim()) {
    return { model: input.explicit.trim(), modelSource: 'call' };
  }
  if (input.envModel?.trim()) {
    return { model: input.envModel.trim(), modelSource: 'env' };
  }
  if (input.sessionModel?.trim()) {
    return { model: input.sessionModel.trim(), modelSource: 'session' };
  }
  return { modelSource: 'cli-default' };
}

export function buildClaudeQueryOptions(input: BuildClaudeQueryOptionsInput): ClaudeQueryPlan {
  const turn = input.turn ?? {};
  const binding = turn.binding ?? input.binding;
  const forkSession = binding === 'resume' && turn.forkSession === true;
  const resumeMode: ClaudeResumeMode =
    binding === 'new' ? 'new' : forkSession ? 'fork' : 'resume';

  const maxTurns = resolveClaudeMaxTurns(turn.maxTurns);
  const permissionMode = resolveClaudePermissionMode(turn.permissionMode);
  const allowedTools = resolveClaudeToolList(turn.allowedTools, 'WINGMAN_CLAUDE_ALLOWED_TOOLS');
  const disallowedTools = resolveClaudeToolList(
    turn.disallowedTools,
    'WINGMAN_CLAUDE_DISALLOWED_TOOLS',
  );
  const { model, modelSource } = resolveClaudeTurnModel({
    explicit: turn.model,
    envModel: input.envModel ?? resolveClaudeModelOverride(),
    sessionModel: input.sessionModel,
  });

  const options: ClaudeQueryOptionBag = {
    cwd: input.cwd,
    maxTurns,
    permissionMode,
    permissionPrompts: 'host',
  };

  if (binding === 'resume' && input.sessionId) {
    options.resume = input.sessionId;
    options.forkSession = forkSession;
  } else if (binding === 'new' && input.sessionId) {
    options.sessionId = input.sessionId;
  }

  if (model) options.model = model;
  if (allowedTools) options.allowedTools = allowedTools;
  if (disallowedTools) options.disallowedTools = disallowedTools;
  if (permissionMode === 'bypassPermissions') {
    options.allowDangerouslySkipPermissions = true;
  }

  return {
    resumeMode,
    forkSession,
    maxTurns,
    permissionMode,
    model,
    modelSource,
    allowedTools,
    disallowedTools,
    options,
    note: claudeTurnNote(resumeMode),
  };
}

/**
 * Pull a model id out of historical session messages.
 * Assistant API messages carry `message.model`. System init records may too.
 * Returns undefined when the transcript does not say.
 */
export function extractModelFromSessionMessages(
  messages: Array<{ message?: unknown; type?: string }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const model = modelFromUnknown(messages[i]?.message) ?? modelFromUnknown(messages[i]);
    if (model) return model;
  }
  return undefined;
}

function modelFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const model = (value as { model?: unknown }).model;
  if (typeof model === 'string' && model.trim()) return model.trim();
  return undefined;
}

export interface ClaudePromptMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  priority?: 'now' | 'next' | 'later';
}

/**
 * Streaming prompt input. The Agent SDK only honors Query.interrupt() and
 * mid-turn user messages when the prompt is an async iterable that stays
 * open for the life of the query. A string prompt is one-shot: the CLI
 * exits after the turn and control requests are unavailable.
 */
export class ClaudePromptStream {
  private queue: Array<{ text: string; priority?: 'now' | 'next' | 'later' }> = [];
  private waiter: (() => void) | null = null;
  private finished = false;

  push(text: string, priority?: 'now' | 'next' | 'later'): boolean {
    if (this.finished) return false;
    this.queue.push({ text, priority });
    this.wake();
    return true;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.wake();
  }

  get queued(): number {
    return this.queue.length;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  async *iterate(): AsyncGenerator<ClaudePromptMessage> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield {
          type: 'user',
          message: { role: 'user', content: next.text },
          parent_tool_use_id: null,
          ...(next.priority ? { priority: next.priority } : {}),
        };
        continue;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
}

export function readMessageSessionId(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const sessionId = (msg as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : undefined;
}

export function readInitModel(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const record = msg as { type?: unknown; subtype?: unknown; model?: unknown };
  if (record.type === 'system' && record.subtype === 'init' && typeof record.model === 'string') {
    const model = record.model.trim();
    return model || undefined;
  }
  return undefined;
}

export function readResultText(msg: unknown): { text?: string; failed: boolean; error?: string } | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const record = msg as { type?: unknown; subtype?: unknown; result?: unknown; errors?: unknown };
  if (record.type !== 'result') return undefined;
  const failed = record.subtype !== undefined && record.subtype !== 'success';
  const text =
    typeof record.result === 'string' && record.result.trim()
      ? record.result
      : Array.isArray(record.errors) && record.errors.length > 0
        ? record.errors.map((entry) => String(entry)).join('\n')
        : undefined;
  const error = failed ? (typeof record.subtype === 'string' ? record.subtype : 'error') : undefined;
  return { text, failed, error };
}
