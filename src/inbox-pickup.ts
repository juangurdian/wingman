/**
 * What an inbox write means for an interactive Claude session.
 *
 * The public wire format is an auth line plus a user message. It has no submit
 * or wake line. Current Claude Code is supposed to start a turn when the
 * session is idle, and to fold the text in between tool calls when it is not.
 * Some builds, including Windows desktop builds in the 2.1.227 line, only
 * place the text in the composer until a person presses Enter.
 *
 * Wingman reports that honestly. A headless resume is opt-in, and only when
 * the session was idle before the write and is still idle after the wait.
 */

import type { SendMessageResult } from './providers/types.js';

export type InboxLivePhase = 'idle' | 'mid_turn' | 'unknown';
export type InboxFallback = 'none' | 'headless';
export type InboxDeliveryState = 'started' | 'queued_not_started' | 'queued_mid_turn' | 'not_delivered';

const IDLE = new Set(['idle', 'ready', 'prompt', 'waiting_for_input']);

export function classifyLivePhase(status?: string): InboxLivePhase {
  if (!status?.trim()) return 'unknown';
  const value = status.trim().toLowerCase();
  if (IDLE.has(value) || value === 'idle') return 'idle';
  if (
    value === 'shell' ||
    value.includes('busy') ||
    value.includes('running') ||
    value.includes('working') ||
    value.includes('tool') ||
    value.includes('think') ||
    value.includes('respond') ||
    value.includes('wait') ||
    value === 'active' ||
    value.includes('shell')
  ) {
    return 'mid_turn';
  }
  return 'unknown';
}

export function resolveInboxFallback(explicit?: string): InboxFallback {
  const value = (explicit ?? process.env.WINGMAN_INBOX_FALLBACK ?? 'none').trim().toLowerCase();
  return value === 'headless' ? 'headless' : 'none';
}

export function resolveInboxPickupMs(explicit?: number): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit >= 0) {
    return Math.min(explicit, 60_000);
  }
  const env = process.env.WINGMAN_INBOX_PICKUP_MS?.trim();
  if (env && /^\d+$/.test(env)) return Math.min(Number(env), 60_000);
  return 5_000;
}

export interface InboxDecision {
  status: 'delivered_via_inbox' | 'queued_not_started' | 'inbox_not_delivered';
  inboxState: InboxDeliveryState;
  headless: boolean;
  attachedToTerminal: boolean;
  note: string;
}

const STARTED =
  'The inbox accepted the message and the session left idle, so a turn started. This did not start a headless resume.';
const MID_TURN_QUEUED =
  'The interactive session is mid-turn. The inbox accepted the message for delivery between tool calls. Wingman did not start a headless resume.';
const QUEUED_IDLE =
  'The inbox accepted the message, but the session stayed idle. Some Claude Code builds only put that text in the composer until a person presses Enter. The wire protocol has no extra submit line Wingman can send. status is queued_not_started. Pass inbox_fallback "headless" to resume headless after the wait, and only when the session is idle.';
const QUEUED_UNKNOWN =
  'The inbox accepted the message, but Wingman could not see the session leave idle. status is queued_not_started. Wingman did not start a headless resume, because the session might be mid-turn.';
const QUEUED_IDLE_FALLBACK =
  'The inbox accepted the message and the session stayed idle, so Wingman is starting a headless resume. The interactive composer may still hold the same text. Pressing Enter there can run it a second time.';
const MID_TURN_FAIL =
  'The inbox write failed while the interactive session is mid-turn. Wingman did not start a headless resume.';
const UNKNOWN_FAIL =
  'The inbox write failed and the session phase is unknown. Wingman did not start a headless resume.';
const IDLE_FAIL =
  'The inbox write failed and the session is idle. A headless resume does not race an interactive turn.';

export function decideInboxDelivery(input: {
  writeOk: boolean;
  before: InboxLivePhase;
  after: InboxLivePhase;
  fallback: InboxFallback;
}): InboxDecision {
  if (!input.writeOk) {
    if (input.before === 'mid_turn') {
      return {
        status: 'inbox_not_delivered',
        inboxState: 'not_delivered',
        headless: false,
        attachedToTerminal: true,
        note: MID_TURN_FAIL,
      };
    }
    if (input.before === 'unknown') {
      return {
        status: 'inbox_not_delivered',
        inboxState: 'not_delivered',
        headless: false,
        attachedToTerminal: true,
        note: UNKNOWN_FAIL,
      };
    }
    return {
      status: 'inbox_not_delivered',
      inboxState: 'not_delivered',
      headless: true,
      attachedToTerminal: false,
      note: IDLE_FAIL,
    };
  }

  if (input.before === 'mid_turn') {
    return {
      status: 'delivered_via_inbox',
      inboxState: 'queued_mid_turn',
      headless: false,
      attachedToTerminal: true,
      note: MID_TURN_QUEUED,
    };
  }

  if (input.after === 'mid_turn') {
    return {
      status: 'delivered_via_inbox',
      inboxState: 'started',
      headless: false,
      attachedToTerminal: true,
      note: STARTED,
    };
  }

  if (input.fallback === 'headless' && input.before === 'idle' && input.after === 'idle') {
    return {
      status: 'queued_not_started',
      inboxState: 'queued_not_started',
      headless: true,
      attachedToTerminal: false,
      note: QUEUED_IDLE_FALLBACK,
    };
  }

  return {
    status: 'queued_not_started',
    inboxState: 'queued_not_started',
    headless: false,
    attachedToTerminal: true,
    note: input.before === 'idle' ? QUEUED_IDLE : QUEUED_UNKNOWN,
  };
}

export interface InboxPhaseRow {
  sessionId: string;
  status?: string;
  state?: string;
}

export async function watchInboxPhase(opts: {
  sessionId: string;
  timeoutMs: number;
  pollMs?: number;
  list: () => Promise<InboxPhaseRow[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<InboxLivePhase> {
  const pollMs = opts.pollMs ?? 250;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const start = now();
  let phase: InboxLivePhase = 'unknown';
  for (;;) {
    const rows = await opts.list();
    const row = rows.find((item) => item.sessionId === opts.sessionId);
    phase = classifyLivePhase(row?.status ?? row?.state);
    if (phase === 'mid_turn') return phase;
    const elapsed = now() - start;
    if (elapsed >= opts.timeoutMs) return phase;
    await sleep(Math.min(pollMs, Math.max(0, opts.timeoutMs - elapsed)));
  }
}

export async function deliverInteractiveInbox(opts: {
  sessionId: string;
  beforeStatus?: string;
  pickupMs: number;
  fallback: InboxFallback;
  send: () => Promise<{ delivered: boolean; error?: string }>;
  list: () => Promise<InboxPhaseRow[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ headless: boolean; result: SendMessageResult }> {
  const before = classifyLivePhase(opts.beforeStatus);
  const write = await opts.send();
  if (!write.delivered) {
    const decision = decideInboxDelivery({
      writeOk: false,
      before,
      after: before,
      fallback: 'none',
    });
    if (decision.headless) {
      return { headless: true, result: toResult(opts.sessionId, decision) };
    }
    return { headless: false, result: toResult(opts.sessionId, decision) };
  }

  const after =
    before === 'mid_turn'
      ? before
      : await watchInboxPhase({
          sessionId: opts.sessionId,
          timeoutMs: opts.pickupMs,
          list: opts.list,
          now: opts.now,
          sleep: opts.sleep,
        });
  const decision = decideInboxDelivery({
    writeOk: true,
    before,
    after,
    fallback: opts.fallback,
  });
  return { headless: decision.headless, result: toResult(opts.sessionId, decision) };
}

function toResult(sessionId: string, decision: InboxDecision): SendMessageResult {
  return {
    sessionId,
    status: decision.status,
    inboxState: decision.inboxState,
    attachedToTerminal: decision.attachedToTerminal,
    note: decision.note,
  };
}
