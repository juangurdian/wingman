export type SessionRunState = 'idle' | 'working' | 'awaiting_approval' | 'errored';

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
