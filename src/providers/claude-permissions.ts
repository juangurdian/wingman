/**
 * Holds Claude Agent SDK canUseTool prompts until the supervisor
 * resolves them through list_approvals / resolve_approval.
 * A prompt that is not resolved in time is denied.
 */

import { randomUUID } from 'node:crypto';
import { resolveClaudeApprovalTimeoutMs } from '../config.js';
import type { Approval, ApprovalDecision, ApprovalKind, ResolveApprovalResult } from './types.js';

export interface ClaudePermissionContext {
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  turnId?: string;
  signal: AbortSignal;
  suggestions?: unknown[];
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
  timeoutMs?: number;
}

export interface ClaudePermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  interrupt?: boolean;
  updatedPermissions?: unknown[];
  toolUseID?: string;
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
}

interface SessionRule {
  toolName: string;
  /** Exact command or path this allow covers. Absent means the whole tool. */
  ruleContent?: string;
}

interface PendingPermission {
  approval: Approval;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  toolUseID?: string;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (decision: ClaudePermissionDecision) => void;
}

const COMMAND_TOOLS = new Set(['bash', 'powershell']);
const FILE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
const NETWORK_TOOLS = new Set(['webfetch', 'websearch']);

export class ClaudePermissionBroker {
  private pending = new Map<string, PendingPermission>();
  private sessionRules = new Map<string, SessionRule[]>();

  list(sessionId: string): Approval[] {
    const approvals: Approval[] = [];
    for (const pending of this.pending.values()) {
      if (pending.approval.sessionId === sessionId) approvals.push(pending.approval);
    }
    return approvals;
  }

  resolve(sessionId: string, approvalId: string, decision: ApprovalDecision): ResolveApprovalResult {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.approval.sessionId !== sessionId) {
      return {
        sessionId,
        approvalId,
        resolved: false,
        error: `Approval not found: ${approvalId}`,
      };
    }

    const toolUseID = pending.toolUseID;
    if (decision === 'accept' || decision === 'acceptForSession') {
      if (decision === 'acceptForSession') {
        this.remember(sessionId, {
          toolName: pending.toolName,
          ruleContent: ruleContentFor(pending.toolName, pending.input),
        });
      }
      const updatedPermissions =
        decision === 'acceptForSession'
          ? pending.suggestions && pending.suggestions.length > 0
            ? pending.suggestions
            : [
                {
                  type: 'addRules',
                  rules: [
                    {
                      toolName: pending.toolName,
                      ruleContent: ruleContentFor(pending.toolName, pending.input),
                    },
                  ],
                  behavior: 'allow',
                  destination: 'session',
                },
              ]
          : undefined;
      this.finish(approvalId, {
        behavior: 'allow',
        updatedPermissions,
        toolUseID,
        decisionClassification: decision === 'acceptForSession' ? 'user_permanent' : 'user_temporary',
      });
    } else if (decision === 'cancel') {
      this.finish(approvalId, {
        behavior: 'deny',
        message: 'Cancelled by Wingman supervisor.',
        interrupt: true,
        toolUseID,
        decisionClassification: 'user_reject',
      });
    } else {
      this.finish(approvalId, {
        behavior: 'deny',
        message: 'Denied by Wingman supervisor.',
        toolUseID,
        decisionClassification: 'user_reject',
      });
    }

    return { sessionId, approvalId, resolved: true, decision };
  }

  request(ctx: ClaudePermissionContext): Promise<ClaudePermissionDecision> {
    const auto = this.matchSessionRule(ctx.sessionId, ctx.toolName, ctx.input);
    if (auto) {
      return Promise.resolve({
        behavior: 'allow',
        toolUseID: ctx.toolUseID,
        decisionClassification: 'user_permanent',
      });
    }

    if (ctx.signal.aborted) {
      return Promise.resolve(denied('Turn aborted before approval.', ctx.toolUseID));
    }

    const id = `appr_${randomUUID().slice(0, 8)}`;
    const approval = toApproval(id, ctx);
    const timeoutMs = resolveClaudeApprovalTimeoutMs(ctx.timeoutMs);

    return new Promise((resolve) => {
      const finishDeny = (message: string) => {
        if (!this.pending.has(id)) return;
        this.finish(id, denied(message, ctx.toolUseID));
      };

      const timer = setTimeout(() => {
        finishDeny('Wingman approval timed out; denied.');
      }, timeoutMs);

      const onAbort = () => {
        finishDeny('Turn aborted before approval.');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        approval,
        toolName: ctx.toolName,
        input: ctx.input,
        suggestions: ctx.suggestions,
        toolUseID: ctx.toolUseID,
        timer,
        signal: ctx.signal,
        onAbort,
        resolve,
      });
    });
  }

  /** Deny every prompt still open for this session. Used by interrupt. */
  cancelSession(sessionId: string, message = 'Turn interrupted before approval.'): void {
    for (const [id, pending] of this.pending) {
      if (pending.approval.sessionId !== sessionId) continue;
      this.finish(id, denied(message, pending.toolUseID));
    }
  }

  private remember(sessionId: string, rule: SessionRule): void {
    const rules = this.sessionRules.get(sessionId) ?? [];
    const key = ruleKey(rule);
    if (!rules.some((existing) => ruleKey(existing) === key)) {
      rules.push(rule);
      this.sessionRules.set(sessionId, rules);
    }
  }

  private matchSessionRule(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    const rules = this.sessionRules.get(sessionId);
    if (!rules) return false;
    const content = ruleContentFor(toolName, input);
    return rules.some((rule) => {
      if (rule.toolName !== toolName) return false;
      if (!rule.ruleContent) return true;
      return content !== undefined && rule.ruleContent === content;
    });
  }

  private finish(approvalId: string, decision: ClaudePermissionDecision): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    this.pending.delete(approvalId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(decision);
  }
}

function denied(message: string, toolUseID?: string): ClaudePermissionDecision {
  return {
    behavior: 'deny',
    message,
    toolUseID,
    decisionClassification: 'user_reject',
  };
}

export function approvalKindForTool(toolName: string): ApprovalKind {
  const normalized = toolName.toLowerCase();
  if (COMMAND_TOOLS.has(normalized)) return 'command';
  if (FILE_TOOLS.has(normalized)) return 'fileChange';
  if (NETWORK_TOOLS.has(normalized)) return 'network';
  return 'command';
}

function ruleContentFor(toolName: string, input: Record<string, unknown>): string | undefined {
  const command = stringField(input, 'command');
  if (command) return command;
  return (
    stringField(input, 'file_path') ??
    stringField(input, 'path') ??
    stringField(input, 'notebook_path') ??
    stringField(input, 'url')
  );
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  const content = ruleContentFor(toolName, input);
  if (content) return content;
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return toolName;
  }
}

function toApproval(id: string, ctx: ClaudePermissionContext): Approval {
  const kind = approvalKindForTool(ctx.toolName);
  const summary = summarizeInput(ctx.toolName, ctx.input);
  const reasonParts = [ctx.title, ctx.description, ctx.decisionReason].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  const reason = reasonParts[0] ?? `Tool ${ctx.toolName} needs approval`;
  return {
    id,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    kind,
    command: kind === 'command' ? summary : undefined,
    cwd: stringField(ctx.input, 'cwd') ?? ctx.blockedPath,
    reason: ctx.blockedPath ? `${reason} (${ctx.blockedPath})` : reason,
    toolName: ctx.toolName,
    requestedAt: Date.now(),
  };
}

function ruleKey(rule: SessionRule): string {
  return `${rule.toolName}\0${rule.ruleContent ?? '*'}`;
}
