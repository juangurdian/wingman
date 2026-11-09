/**
 * Background Codex exec and Claude runs.
 * Prompts are never interpolated into a shell command.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { buildCodexExecArgs } from './codex-exec.js';
import { readRssBytes } from './process-rss.js';
import type { ProviderRegistry } from './providers/index.js';
import type { SendMessageOptions, SessionActivity } from './providers/types.js';

export type RunKind = 'codex-exec' | 'claude';
export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'killed';

export interface HeadlessRun {
  id: string;
  kind: RunKind;
  status: RunStatus;
  prompt: string;
  cwd?: string;
  model?: string;
  sandbox?: string;
  sessionId?: string;
  pid?: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  output: string;
  /** How the prompt was delivered. Never a PowerShell command string. */
  promptDelivery: 'stdin' | 'sdk-string';
  shell: false;
  sharedProcess: boolean;
}

export interface PublicRun extends Omit<HeadlessRun, 'output'> {
  memoryBytes?: number;
  tail?: string;
}

interface SpawnChild {
  pid?: number;
  stdin: { write(chunk: string, enc?: BufferEncoding): void; end(): void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd?: string; shell: false; windowsHide: true },
) => SpawnChild;

const OUTPUT_CAP = 100_000;

function defaultSpawn(command: string, args: string[], opts: { cwd?: string; shell: false; windowsHide: true }): SpawnChild {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  return child;
}

function appendOutput(run: HeadlessRun, chunk: string): void {
  run.output += chunk;
  if (run.output.length > OUTPUT_CAP) {
    run.output = run.output.slice(run.output.length - OUTPUT_CAP);
  }
}

function tailOf(text: string, lines: number): string {
  const parts = text.split(/\r?\n/);
  return parts.slice(-Math.max(1, lines)).join('\n');
}

function readThreadId(line: string): string | undefined {
  try {
    const msg = JSON.parse(line) as { type?: string; thread_id?: string };
    if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') return msg.thread_id;
  } catch {
    /* not json */
  }
  return undefined;
}

export class HeadlessRuns {
  private runs = new Map<string, HeadlessRun>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private children = new Map<string, SpawnChild>();

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly spawnFn: SpawnFn = defaultSpawn,
    private readonly rss: (pid: number) => number | undefined = readRssBytes,
  ) {}

  startCodex(input: {
    prompt: string;
    cwd?: string;
    sandbox?: string;
    model?: string;
    resumeSessionId?: string;
    skipGitRepoCheck?: boolean;
    bin?: string;
  }): HeadlessRun {
    const plan = buildCodexExecArgs(input);
    const id = `run_${randomUUID().slice(0, 8)}`;
    const run: HeadlessRun = {
      id,
      kind: 'codex-exec',
      status: 'running',
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      sandbox: plan.args.includes('--sandbox') ? plan.args[plan.args.indexOf('--sandbox') + 1] : undefined,
      sessionId: input.resumeSessionId,
      startedAt: Date.now(),
      output: '',
      promptDelivery: 'stdin',
      shell: false,
      sharedProcess: false,
    };
    this.runs.set(id, run);

    let child: SpawnChild;
    try {
      child = this.spawnFn(input.bin || process.env.CODEX_BIN || 'codex', plan.args, {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.finishedAt = Date.now();
      return run;
    }
    run.pid = child.pid;
    this.children.set(id, child);
    child.stdin.write(input.prompt, 'utf8');
    child.stdin.end();

    const onData = (buf: Buffer | string) => {
      const text = typeof buf === 'string' ? buf : buf.toString('utf8');
      appendOutput(run, text);
      for (const line of text.split(/\r?\n/)) {
        const threadId = readThreadId(line);
        if (threadId) run.sessionId = threadId;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      run.status = 'failed';
      run.error = err.message;
      run.finishedAt = Date.now();
    });
    child.on('exit', (code) => {
      if (run.status === 'killed') return;
      run.exitCode = code;
      run.finishedAt = Date.now();
      run.status = code === 0 ? 'completed' : 'failed';
      if (code !== 0 && !run.error) run.error = `codex exec exited ${code}`;
    });
    return run;
  }

  async startClaude(input: {
    prompt: string;
    cwd?: string;
    sessionId?: string;
    model?: string;
    maxTurns?: number;
    permissionMode?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    approvalTimeoutMs?: number;
  }): Promise<HeadlessRun> {
    const provider = this.providers.claude;
    const turn: SendMessageOptions = {
      model: input.model,
      maxTurns: input.maxTurns,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      approvalTimeoutMs: input.approvalTimeoutMs,
    };
    let sessionId = input.sessionId;
    if (sessionId) {
      await provider.sendMessage(sessionId, input.prompt, turn);
    } else {
      if (!provider.createSession) throw new Error('Claude provider cannot create a session');
      const created = await provider.createSession({
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        maxTurns: input.maxTurns,
        permissionMode: input.permissionMode,
        allowedTools: input.allowedTools,
        disallowedTools: input.disallowedTools,
        approvalTimeoutMs: input.approvalTimeoutMs,
      });
      sessionId = created.sessionId;
    }

    const id = `run_${randomUUID().slice(0, 8)}`;
    const run: HeadlessRun = {
      id,
      kind: 'claude',
      status: 'running',
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      sessionId,
      pid: process.pid,
      startedAt: Date.now(),
      output: '',
      promptDelivery: 'sdk-string',
      shell: false,
      sharedProcess: true,
    };
    this.runs.set(id, run);
    this.watchClaude(run);
    return run;
  }

  private watchClaude(run: HeadlessRun): void {
    const provider = this.providers.claude;
    const timer = setInterval(() => {
      if (!run.sessionId || run.status === 'killed') {
        clearInterval(timer);
        return;
      }
      const activity: SessionActivity | undefined = provider.activity?.(run.sessionId);
      if (!activity) return;
      if (activity.model) run.model = activity.model;
      if (activity.approvalCount > 0) {
        run.status = 'awaiting_approval';
        return;
      }
      if (activity.running) {
        run.status = 'running';
        return;
      }
      run.status = activity.error ? 'failed' : 'completed';
      run.error = activity.error;
      run.finishedAt = Date.now();
      clearInterval(timer);
      this.timers.delete(run.id);
      void this.captureClaudeTail(run);
    }, 40);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(run.id, timer);
  }

  private async captureClaudeTail(run: HeadlessRun): Promise<void> {
    if (!run.sessionId) return;
    try {
      const transcript = await this.providers.claude.readTranscript(run.sessionId, 40);
      run.output = transcript.items.map((item) => `${item.role}: ${item.text}`).join('\n');
    } catch (err) {
      run.output = err instanceof Error ? err.message : String(err);
    }
  }

  get(id: string, tailLines = 80): PublicRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return this.publish(run, tailLines);
  }

  list(): PublicRun[] {
    return [...this.runs.values()].map((run) => this.publish(run, 0));
  }

  runsForSession(sessionId: string): PublicRun[] {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .map((run) => this.publish(run, 0));
  }

  stop(id: string, force = false): PublicRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    this.stopRun(run, force);
    return this.publish(run, 40);
  }

  stopBySession(sessionId: string, force = false): PublicRun[] {
    const stopped: PublicRun[] = [];
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.status === 'running' || run.status === 'awaiting_approval') {
        this.stopRun(run, force);
        stopped.push(this.publish(run, 20));
      }
    }
    return stopped;
  }

  private stopRun(run: HeadlessRun, force: boolean): void {
    const timer = this.timers.get(run.id);
    if (timer) clearInterval(timer);
    this.timers.delete(run.id);
    const live = run.status === 'running' || run.status === 'awaiting_approval';
    if (live) {
      run.status = 'killed';
      run.finishedAt = Date.now();
      run.error = force ? 'killed' : 'stopped';
    }
    if (run.kind === 'codex-exec') {
      const child = this.children.get(run.id);
      if (child && live) child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } else if (run.sessionId && live) {
      void this.providers.claude.interrupt(run.sessionId).catch(() => undefined);
    }
  }

  private publish(run: HeadlessRun, tailLines: number): PublicRun {
    const memoryBytes = run.pid ? this.rss(run.pid) : undefined;
    const { output, ...rest } = run;
    return {
      ...rest,
      memoryBytes,
      tail: tailLines > 0 ? tailOf(output, tailLines) : undefined,
    };
  }
}
