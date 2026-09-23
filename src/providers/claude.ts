/**
 * Claude provider stub.
 *
 * Full Claude Code session control is not yet enabled.
 * Optional minimal wrap of `claude -p` can be toggled later without heavy deps.
 *
 * TODO: wire Claude Code headless / SDK when stable session APIs exist.
 */

import { spawn } from 'node:child_process';
import type {
  CreateSessionResult,
  InterruptResult,
  SendMessageResult,
  SessionProvider,
  SessionSummary,
  Transcript,
} from './types.js';

const NOT_ENABLED =
  'Claude provider is not yet enabled. Use provider=codex for now. ' +
  'Set CLAUDE_STUB_EXEC=1 to attempt a one-shot `claude -p` prompt (no real session).';

export class ClaudeProvider implements SessionProvider {
  readonly name = 'claude' as const;

  async listSessions(): Promise<SessionSummary[]> {
    throw new Error(NOT_ENABLED);
  }

  async readTranscript(_sessionId: string, _limit?: number): Promise<Transcript> {
    throw new Error(NOT_ENABLED);
  }

  async sendMessage(_sessionId: string, text: string): Promise<SendMessageResult> {
    if (process.env.CLAUDE_STUB_EXEC === '1') {
      const out = await runClaudePrint(text);
      return {
        sessionId: 'claude-oneshot',
        status: 'completed-oneshot',
        turnId: out.slice(0, 40),
      };
    }
    throw new Error(NOT_ENABLED);
  }

  async interrupt(_sessionId: string): Promise<InterruptResult> {
    throw new Error(NOT_ENABLED);
  }

  async createSession(_opts?: { cwd?: string; prompt?: string }): Promise<CreateSessionResult> {
    throw new Error(NOT_ENABLED);
  }
}

function runClaudePrint(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to spawn claude CLI: ${err.message}. Install Claude Code or unset CLAUDE_STUB_EXEC.`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim() || '(empty)');
      else reject(new Error(`claude -p exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}
