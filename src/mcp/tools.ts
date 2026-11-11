import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRegistry, ProviderName } from '../providers/index.js';
import type { SessionSummary, Transcript, TranscriptItem } from '../providers/types.js';
import { isPathAllowed, resolveAllowlist, type AllowlistPolicy } from '../allowlist.js';
import { readGitSnapshot, type GitRunner } from '../git-status.js';
import { HeadlessRuns } from '../headless-runs.js';
import { approvalStallFields, deriveSessionState, memoryNote } from '../session-status.js';
import { readRssBytes } from '../process-rss.js';
import { buildBridgeStatus, type BridgeStatus } from '../reachability.js';
import { listClaudeLiveSessions, sendToClaudeSession } from '../claude-inbox.js';

export const ProviderSchema = z.enum(['codex', 'claude', 'muse']);
export const ExportFormatSchema = z.enum(['markdown', 'json']);

const callerField = {
  caller: z
    .string()
    .min(1)
    .optional()
    .describe('Allowlist caller id. Defaults to WINGMAN_CALLER or "default".'),
};

export const SessionStateFilterSchema = z.enum(['live', 'past', 'all']);

export const ListSessionsSchema = z.object({
  provider: ProviderSchema.optional(),
  state: SessionStateFilterSchema.optional().describe(
    'Claude interactive liveness. live = registry pid is running. past = not live. Default all. Codex sessions are not marked live.',
  ),
  ...callerField,
});

export const ReadTranscriptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
  ...callerField,
});

export const ClaudePermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);

const claudeTurnFields = {
  max_turns: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Claude agent turns before the query stops. Default 50. Ignored by Codex.'),
  permission_mode: ClaudePermissionModeSchema.optional().describe(
    'Claude permission mode. Default "default" so tool prompts reach list_approvals. Ignored by Codex.',
  ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe('Claude tools that run without a permission prompt. Ignored by Codex.'),
  disallowed_tools: z
    .array(z.string())
    .optional()
    .describe('Claude tools removed from the session. Ignored by Codex.'),
  approval_timeout_ms: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe('Claude: deny a permission prompt that is not resolved in time. Default 120000.'),
};

export const SendMessageSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  text: z.string().min(1),
  model: z
    .string()
    .optional()
    .describe(
      'Claude model override for this turn. Omit to inherit the session model. Does not apply to Codex.',
    ),
  fork_session: z
    .boolean()
    .optional()
    .describe('Claude: true copies the session onto a new id. Default false resumes the same id.'),
  force: z
    .boolean()
    .optional()
    .describe('Codex: send even when another client already has the thread loaded.'),
  inbox_fallback: z
    .enum(['none', 'headless'])
    .optional()
    .describe(
      'Claude interactive inbox. none reports queued_not_started when the session stays idle. headless resumes only after the wait, and only while the session is idle. Never used mid-turn.',
    ),
  inbox_pickup_ms: z
    .number()
    .int()
    .nonnegative()
    .max(60_000)
    .optional()
    .describe('How long to watch an idle interactive Claude session for a turn to start. Default 5000.'),
  ...claudeTurnFields,
  ...callerField,
});

export const InterruptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  ...callerField,
});

export const CreateSessionSchema = z.object({
  provider: ProviderSchema,
  cwd: z.string().optional(),
  prompt: z.string().optional(),
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * Model override. Codex: optional, else Codex config.
   * Claude: optional. Omit to let Claude Code pick for a new session.
   * A later send_message inherits the session model when this is unset.
   */
  model: z.string().optional(),
  ...claudeTurnFields,
  ...callerField,
});

export const SetSessionMetaSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  name: z.string().optional(),
  tags: z.array(z.string()).optional(),
  ...callerField,
});

export const GetSessionSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  ...callerField,
});

export const WaitTurnSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  timeout_ms: z.number().int().positive().max(300_000).optional(),
  poll_interval_ms: z.number().int().positive().max(10_000).optional(),
  ...callerField,
});

export const SteerSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  text: z.string().min(1),
  ...callerField,
});

export const ListApprovalsSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  ...callerField,
});

export const ApprovalDecisionSchema = z.enum(['accept', 'acceptForSession', 'decline', 'cancel']);

export const ResolveApprovalSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  approval_id: z.string().min(1),
  decision: ApprovalDecisionSchema,
  ...callerField,
});

export const ExportTranscriptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  format: ExportFormatSchema,
  limit: z.number().int().positive().max(500).optional(),
  ...callerField,
});

export const CodexSandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

export const GetStatusSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  ...callerField,
});

export const StartCodexExecSchema = z.object({
  prompt: z.string().min(1).describe('Prompt text. Passed on stdin, not through PowerShell.'),
  cwd: z.string().min(1),
  sandbox: CodexSandboxSchema.optional().describe(
    'Codex CLI 0.166 sandbox. Default read-only. Do not use full-auto; it was removed.',
  ),
  model: z.string().optional(),
  resume_session_id: z.string().min(1).optional(),
  skip_git_repo_check: z.boolean().optional(),
  ...callerField,
});

export const RunHeadlessSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('Prompt text passed straight to the Agent SDK. Not a PowerShell string.'),
  cwd: z.string().optional(),
  session_id: z.string().min(1).optional(),
  model: z.string().optional(),
  ...claudeTurnFields,
  ...callerField,
});

export const GetRunSchema = z.object({
  run_id: z.string().min(1),
  tail_lines: z.number().int().positive().max(500).optional(),
  ...callerField,
});

export const GetBridgeStatusSchema = z.object({});

export const ListClaudeLiveSessionsSchema = z.object({});

export const SendToClaudeSessionSchema = z.object({
  target: z.string().min(1).describe('Interactive Claude session id, name, or pid.'),
  text: z.string().min(1).describe('Message text. Delivered on the session inbox, not via PowerShell.'),
  ...callerField,
});

export const StopSchema = z.object({
  provider: ProviderSchema.optional(),
  session_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  force: z.boolean().optional().describe('SIGKILL a headless codex exec process. Sessions are interrupted.'),
  ...callerField,
});

function textResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
  };
}

export interface ToolDeps {
  allowlist?: (caller?: string) => AllowlistPolicy;
  git?: GitRunner;
  runs?: HeadlessRuns;
  rss?: (pid: number) => number | undefined;
  bridgeStatus?: () => BridgeStatus;
}

export function createToolHandlers(providers: ProviderRegistry, deps: ToolDeps = {}) {
  const runs = deps.runs ?? new HeadlessRuns(providers);
  const rss = deps.rss ?? readRssBytes;
  const policyFor = (caller?: string) => deps.allowlist?.(caller) ?? resolveAllowlist({ caller });

  async function ensureSession(
    providerName: ProviderName,
    sessionId: string,
    caller?: string,
  ): Promise<void> {
    const policy = policyFor(caller);
    if (!policy.enforced) return;
    const provider = providers.get(providerName);
    const session = provider.getSession ? await provider.getSession(sessionId) : null;
    if (!session) return;
    if (!isPathAllowed(session.cwd, policy.paths)) {
      throw new Error(`Session ${sessionId} is outside the allowlist for caller "${policy.caller}".`);
    }
  }

  function ensureCwd(cwd: string | undefined, caller?: string): void {
    const policy = policyFor(caller);
    if (!policy.enforced) return;
    if (!isPathAllowed(cwd, policy.paths)) {
      throw new Error(`cwd is outside the allowlist for caller "${policy.caller}".`);
    }
  }

  function visibleSessions(sessions: SessionSummary[], caller?: string): SessionSummary[] {
    const policy = policyFor(caller);
    if (!policy.enforced) return sessions;
    return sessions.filter((session) => {
      if (session.status === 'not_enabled') return true;
      return isPathAllowed(session.cwd, policy.paths);
    });
  }

  async function stampApprovalStall(sessions: SessionSummary[]): Promise<SessionSummary[]> {
    const now = Date.now();
    const stamped: SessionSummary[] = [];
    for (const session of sessions) {
      if (session.status === 'not_enabled' || session.id.startsWith('_')) {
        stamped.push({ ...session, pendingApprovalAgeMs: null, stalled_on_approval: false });
        continue;
      }
      const provider = providers.get(session.provider);
      if (!provider.listApprovals) {
        stamped.push({ ...session, pendingApprovalAgeMs: null, stalled_on_approval: false });
        continue;
      }
      try {
        const listed = await provider.listApprovals(session.id);
        stamped.push({ ...session, ...approvalStallFields(listed.approvals, now) });
      } catch {
        stamped.push({ ...session, pendingApprovalAgeMs: null, stalled_on_approval: false });
      }
    }
    return stamped;
  }

  return {
    async list_sessions(args: z.infer<typeof ListSessionsSchema>) {
      try {
        const names: ProviderName[] = args.provider
          ? [args.provider]
          : ['codex', 'claude', 'muse'];
        const sessions: SessionSummary[] = [];
        for (const name of names) {
          try {
            const provider = providers.get(name);
            const list = await provider.listSessions(
              name === 'claude' ? { state: args.state ?? 'all' } : undefined,
            );
            sessions.push(...list);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isSpawnError = errMsg.includes('ENOENT') || errMsg.includes('spawn') || errMsg.includes('not found');
            
            if (name === 'codex') {
              // Gracefully degrade when Codex binary not found (Windows PATH issue, etc.)
              // Instead of hard-failing, return a stub so Claude-only mode works
              sessions.push({
                id: '_codex_stub',
                provider: 'codex' as const,
                preview: isSpawnError 
                  ? 'Codex binary not found. Install Codex or set CODEX_MOCK=1' 
                  : errMsg,
                status: 'not_enabled',
              });
            } else if (name === 'claude') {
              sessions.push({
                id: '_claude_stub',
                provider: 'claude' as const,
                preview: errMsg,
                status: 'not_enabled',
              });
            } else if (name === 'muse') {
              sessions.push({
                id: '_muse_stub',
                provider: 'muse' as const,
                preview: errMsg,
                status: 'not_enabled',
              });
            } else {
              throw err;
            }
          }
        }
        let visible = visibleSessions(sessions, args.caller);
        const state = args.state ?? 'all';
        if (state === 'live') {
          visible = visible.filter((session) => session.live === true);
        } else if (state === 'past') {
          visible = visible.filter((session) => session.status !== 'not_enabled' && session.live !== true);
        }
        const stamped = await stampApprovalStall(visible);
        return textResult({ sessions: stamped });
      } catch (err) {
        return errorResult(err);
      }
    },

    async read_transcript(args: z.infer<typeof ReadTranscriptSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const transcript = await providers
          .get(args.provider)
          .readTranscript(args.session_id, args.limit);
        return textResult(transcript);
      } catch (err) {
        return errorResult(err);
      }
    },

    async send_message(args: z.infer<typeof SendMessageSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const result = await providers.get(args.provider).sendMessage(args.session_id, args.text, {
          maxTurns: args.max_turns,
          permissionMode: args.permission_mode,
          allowedTools: args.allowed_tools,
          disallowedTools: args.disallowed_tools,
          model: args.model,
          forkSession: args.fork_session,
          approvalTimeoutMs: args.approval_timeout_ms,
          force: args.force,
          inboxFallback: args.inbox_fallback,
          inboxPickupMs: args.inbox_pickup_ms,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async interrupt(args: z.infer<typeof InterruptSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const result = await providers.get(args.provider).interrupt(args.session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async create_session(args: z.infer<typeof CreateSessionSchema>) {
      try {
        ensureCwd(args.cwd, args.caller);
        const provider = providers.get(args.provider);
        if (!provider.createSession) {
          return errorResult(`create_session not supported for ${args.provider}`);
        }
        const result = await provider.createSession({
          cwd: args.cwd,
          prompt: args.prompt,
          name: args.name,
          tags: args.tags,
          model: args.model,
          maxTurns: args.max_turns,
          permissionMode: args.permission_mode,
          allowedTools: args.allowed_tools,
          disallowedTools: args.disallowed_tools,
          approvalTimeoutMs: args.approval_timeout_ms,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async set_session_meta(args: z.infer<typeof SetSessionMetaSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const provider = providers.get(args.provider);
        if (!provider.setSessionMeta) {
          return errorResult(`set_session_meta not supported for ${args.provider}`);
        }
        const result = await provider.setSessionMeta(args.session_id, {
          name: args.name,
          tags: args.tags,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async get_session(args: z.infer<typeof GetSessionSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const provider = providers.get(args.provider);
        if (!provider.getSession) {
          return errorResult(`get_session not supported for ${args.provider}`);
        }
        const result = await provider.getSession(args.session_id);
        if (!result) {
          return errorResult(`Session not found: ${args.session_id}`);
        }
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async wait_turn(args: z.infer<typeof WaitTurnSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const provider = providers.get(args.provider);
        if (!provider.waitTurn) {
          return errorResult(`wait_turn not supported for ${args.provider}`);
        }
        const result = await provider.waitTurn(args.session_id, {
          timeoutMs: args.timeout_ms,
          pollIntervalMs: args.poll_interval_ms,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async steer(args: z.infer<typeof SteerSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const provider = providers.get(args.provider);
        if (!provider.steer) {
          return errorResult(`steer not supported for ${args.provider}`);
        }
        const result = await provider.steer(args.session_id, args.text);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async list_approvals(args: z.infer<typeof ListApprovalsSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const provider = providers.get(args.provider);
        if (!provider.listApprovals) {
          return errorResult(`list_approvals not supported for ${args.provider}`);
        }
        const result = await provider.listApprovals(args.session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async resolve_approval(args: z.infer<typeof ResolveApprovalSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const provider = providers.get(args.provider);
        if (!provider.resolveApproval) {
          return errorResult(`resolve_approval not supported for ${args.provider}`);
        }
        const result = await provider.resolveApproval(
          args.session_id,
          args.approval_id,
          args.decision,
        );
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async export_transcript(args: z.infer<typeof ExportTranscriptSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const limit = args.limit ?? 100;
        const transcript = await providers
          .get(args.provider)
          .readTranscript(args.session_id, limit);

        const content =
          args.format === 'markdown'
            ? formatTranscriptAsMarkdown(transcript)
            : formatTranscriptAsJson(transcript);

        const exportDir = join(homedir(), '.wingman', 'exports');
        mkdirSync(exportDir, { recursive: true, mode: 0o700 });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = args.format === 'markdown' ? 'md' : 'json';
        const filename = `${args.provider}_${args.session_id}_${timestamp}.${ext}`;
        const filePath = join(exportDir, filename);

        writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });

        return textResult({
          sessionId: args.session_id,
          provider: args.provider,
          format: args.format,
          itemCount: transcript.items.length,
          path: filePath,
          content,
        });
      } catch (err) {
        return errorResult(err);
      }
    },

    async list_claude_live_sessions() {
      try {
        const sessions = await listClaudeLiveSessions();
        return textResult({ sessions });
      } catch (err) {
        return errorResult(err);
      }
    },

    async send_to_claude_session(args: z.infer<typeof SendToClaudeSessionSchema>) {
      try {
        const result = await sendToClaudeSession(args.target, args.text, { watch: true });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async get_bridge_status() {
      try {
        const status =
          deps.bridgeStatus?.() ??
          buildBridgeStatus({ pid: process.pid, startedAtMs: Date.now(), port: undefined });
        return textResult(status);
      } catch (err) {
        return errorResult(err);
      }
    },

    async get_status(args: z.infer<typeof GetStatusSchema>) {
      try {
        await ensureSession(args.provider, args.session_id, args.caller);
        const provider = providers.get(args.provider);
        const session = provider.getSession ? await provider.getSession(args.session_id) : null;
        if (!session) return errorResult(`Session not found: ${args.session_id}`);
        const approvals = provider.listApprovals
          ? await provider.listApprovals(args.session_id)
          : { sessionId: args.session_id, approvals: [] };
        const activity = provider.activity?.(args.session_id);
        const stall = approvalStallFields(approvals.approvals);
        const state = deriveSessionState({
          running: activity?.running ?? session.status === 'running',
          approvalCount: approvals.approvals.length || activity?.approvalCount || 0,
          error: activity?.error,
        });
        const pendingPrompt =
          state === 'working' || state === 'awaiting_approval' ? activity?.prompt : undefined;
        const git = session.cwd ? readGitSnapshot(session.cwd, deps.git) : undefined;
        const pid = activity?.pid;
        const shared = activity?.sharedProcess ?? true;
        const bytes = pid ? rss(pid) : undefined;
        const headless = runs.runsForSession(args.session_id);
        return textResult({
          sessionId: args.session_id,
          provider: args.provider,
          state,
          lastActivityAt: session.updatedAt ?? activity?.lastActivityAt,
          pendingPrompt,
          lastPrompt: activity?.prompt,
          model: activity?.model ?? session.model,
          error: state === 'errored' ? activity?.error : undefined,
          git: git ?? { dirtyFiles: [], error: 'Session has no cwd, so git was not read.' },
          memory: {
            pid,
            bytes: bytes ?? null,
            shared,
            note: memoryNote(shared, bytes),
          },
          live: session.live,
          processPid: session.pid,
          liveStatus: session.liveStatus,
          pendingApprovalAgeMs: stall.pendingApprovalAgeMs,
          stalled_on_approval: stall.stalled_on_approval,
          runs: headless,
        });
      } catch (err) {
        return errorResult(err);
      }
    },

    async start_codex_exec(args: z.infer<typeof StartCodexExecSchema>) {
      try {
        ensureCwd(args.cwd, args.caller);
        const run = runs.startCodex({
          prompt: args.prompt,
          cwd: args.cwd,
          sandbox: args.sandbox,
          model: args.model,
          resumeSessionId: args.resume_session_id,
          skipGitRepoCheck: args.skip_git_repo_check,
        });
        return textResult({
          runId: run.id,
          status: run.status,
          kind: run.kind,
          cwd: run.cwd,
          sandbox: run.sandbox,
          model: run.model,
          sessionId: run.sessionId,
          pid: run.pid,
          promptDelivery: run.promptDelivery,
          shell: run.shell,
          error: run.error,
        });
      } catch (err) {
        return errorResult(err);
      }
    },

    async run_headless(args: z.infer<typeof RunHeadlessSchema>) {
      try {
        if (args.cwd) ensureCwd(args.cwd, args.caller);
        if (args.session_id) await ensureSession('claude', args.session_id, args.caller);
        if (!args.cwd && !args.session_id) {
          const policy = policyFor(args.caller);
          if (policy.enforced) {
            return errorResult(`cwd is outside the allowlist for caller "${policy.caller}".`);
          }
        }
        const run = await runs.startClaude({
          prompt: args.prompt,
          cwd: args.cwd,
          sessionId: args.session_id,
          model: args.model,
          maxTurns: args.max_turns,
          permissionMode: args.permission_mode,
          allowedTools: args.allowed_tools,
          disallowedTools: args.disallowed_tools,
          approvalTimeoutMs: args.approval_timeout_ms,
        });
        return textResult({
          runId: run.id,
          sessionId: run.sessionId,
          status: run.status,
          kind: run.kind,
          model: run.model,
          promptDelivery: run.promptDelivery,
          shell: run.shell,
          note: 'The prompt was passed as a string to the Agent SDK. It was not sent through PowerShell.',
        });
      } catch (err) {
        return errorResult(err);
      }
    },

    async get_run(args: z.infer<typeof GetRunSchema>) {
      try {
        const run = runs.get(args.run_id, args.tail_lines ?? 80);
        if (!run) return errorResult(`Run not found: ${args.run_id}`);
        if (run.cwd) ensureCwd(run.cwd, args.caller);
        return textResult(run);
      } catch (err) {
        return errorResult(err);
      }
    },

    async stop(args: z.infer<typeof StopSchema>) {
      try {
        if (!args.session_id && !args.run_id) {
          return errorResult('Pass session_id or run_id.');
        }
        const stoppedRuns = [];
        if (args.run_id) {
          const existing = runs.get(args.run_id, 1);
          if (existing?.cwd) ensureCwd(existing.cwd, args.caller);
          const stopped = runs.stop(args.run_id, args.force === true);
          if (!stopped) return errorResult(`Run not found: ${args.run_id}`);
          stoppedRuns.push(stopped);
        }
        let session: unknown;
        if (args.session_id) {
          if (!args.provider) return errorResult('provider is required when stopping a session_id.');
          await ensureSession(args.provider, args.session_id, args.caller);
          const provider = providers.get(args.provider);
          try {
            session = await provider.interrupt(args.session_id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/no known active|no active|unknown mock session/i.test(message)) {
              session = { sessionId: args.session_id, status: 'idle', note: message };
            } else {
              throw err;
            }
          }
          stoppedRuns.push(...runs.stopBySession(args.session_id, args.force === true));
          const activity = provider.activity?.(args.session_id);
          const bytes = activity?.pid ? rss(activity.pid) : undefined;
          return textResult({
            session,
            runs: stoppedRuns,
            memory: activity
              ? {
                  pid: activity.pid,
                  bytes: bytes ?? null,
                  shared: activity.sharedProcess,
                  note: memoryNote(activity.sharedProcess, bytes),
                }
              : undefined,
          });
        }
        return textResult({ runs: stoppedRuns });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

function formatTranscriptAsMarkdown(transcript: Transcript): string {
  const lines: string[] = [
    `# Session Transcript`,
    '',
    `- **Session ID**: ${transcript.sessionId}`,
    `- **Provider**: ${transcript.provider}`,
    `- **Exported**: ${new Date().toISOString()}`,
    `- **Messages**: ${transcript.items.length}`,
    '',
    '---',
    '',
  ];

  for (const item of transcript.items) {
    const roleLabel = formatRole(item.role);
    lines.push(`### ${roleLabel}`);
    if (item.turnId) {
      lines.push(`_Turn: ${item.turnId}_`);
    }
    lines.push('');
    lines.push(item.text);
    lines.push('');
  }

  return lines.join('\n');
}

function formatTranscriptAsJson(transcript: Transcript): string {
  return JSON.stringify(
    {
      sessionId: transcript.sessionId,
      provider: transcript.provider,
      exportedAt: new Date().toISOString(),
      itemCount: transcript.items.length,
      items: transcript.items,
    },
    null,
    2,
  );
}

function formatRole(role: TranscriptItem['role']): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return 'Unknown';
  }
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
