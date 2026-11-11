export type SessionRunState = 'idle' | 'working' | 'awaiting_approval' | 'errored';

/** How long an approval can sit before list_sessions and get_status flag it. */
export const APPROVAL_STALL_MS_DEFAULT = 10 * 60 * 1000;

export function resolveApprovalStallMs(explicit?: number): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit > 0) return explicit;
  const env = process.env.WINGMAN_APPROVAL_STALL_MS?.trim();
  if (env && /^\d+$/.test(env) && Number(env) > 0) return Number(env);
  return APPROVAL_STALL_MS_DEFAULT;
}

export function approvalStallFields(
  approvals: Array<{ requestedAt: number }>,
  now = Date.now(),
  thresholdMs = resolveApprovalStallMs(),
): { pendingApprovalAgeMs: number | null; stalled_on_approval: boolean } {
  if (approvals.length === 0) {
    return { pendingApprovalAgeMs: null, stalled_on_approval: false };
  }
  const oldest = Math.min(...approvals.map((item) => item.requestedAt));
  const pendingApprovalAgeMs = Math.max(0, now - oldest);
  return {
    pendingApprovalAgeMs,
    stalled_on_approval: pendingApprovalAgeMs >= thresholdMs,
  };
}

export function deriveSessionState(input: {
  running: boolean;
  approvalCount: number;
  error?: string;
}): SessionRunState {
  if (input.approvalCount > 0) return 'awaiting_approval';
  if (input.running) return 'working';
  if (input.error) return 'errored';
  return 'idle';
}

export function memoryNote(shared: boolean, bytes: number | undefined): string {
  if (bytes == null) {
    return shared
      ? 'No per-session RSS. This agent shares a process, and the process RSS could not be read (Windows has no /proc for other pids).'
      : 'Process RSS is not available for this pid.';
  }
  if (shared) {
    return 'This process is shared. bytes is the whole process RSS, not a private per-session allocation.';
  }
  return 'RSS for this run process.';
}
