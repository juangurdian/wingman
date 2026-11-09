import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { classifyRemoteFailure, diagnoseLocal, buildBridgeStatus } from '../src/reachability.js';
import { isPathInside, isPathAllowed, resolveCallerPaths, lexicalPath } from '../src/allowlist.js';
import { parsePorcelain, readGitSnapshot } from '../src/git-status.js';
import { parseProcStatusRss } from '../src/process-rss.js';
import { buildWindowsTaskPlan } from '../src/windows-task.js';
import { buildCodexExecArgs, parseCodexSandbox } from '../src/codex-exec.js';
import { deriveSessionState, memoryNote } from '../src/session-status.js';
import { HeadlessRuns, type SpawnFn } from '../src/headless-runs.js';
import { createToolHandlers, StartCodexExecSchema } from '../src/mcp/tools.js';
import { createProviders, type ProviderRegistry, type ProviderName, type SessionProvider, type SessionSummary, type SessionActivity } from '../src/providers/index.js';

describe('remote failure classes', () => {
  it('separates tunnel, server, and host', () => {
    expect(classifyRemoteFailure({ httpStatus: 200 }).state).toBe('server_up');
    expect(classifyRemoteFailure({ httpStatus: 401 }).state).toBe('auth_rejected');
    expect(classifyRemoteFailure({ httpStatus: 530, body: 'error code: 1033' }).state).toBe('tunnel_down');
    expect(classifyRemoteFailure({ body: 'Cloudflare Tunnel error 1033' }).state).toBe('tunnel_down');
    expect(classifyRemoteFailure({ httpStatus: 502 }).state).toBe('server_down');
    expect(classifyRemoteFailure({ errorMessage: 'connect ECONNREFUSED 127.0.0.1:3847' }).state).toBe(
      'server_down',
    );
    expect(classifyRemoteFailure({ errorMessage: 'fetch failed' }).state).toBe('host_offline');
    expect(classifyRemoteFailure({ errorMessage: 'getaddrinfo ENOTFOUND wingman.example' }).state).toBe(
      'host_offline',
    );
  });

  it('uses a local probe to see a crash that a remote 1033 hides', () => {
    const hidden = diagnoseLocal({
      localHttpStatus: undefined,
      localError: 'connect ECONNREFUSED',
      heartbeatAgeMs: 120_000,
      publicStatus: 530,
      publicBody: 'error code: 1033',
    });
    expect(hidden.hostOnline).toBe(true);
    expect(hidden.serverListening).toBe(false);
    expect(hidden.state).toBe('server_down');
    expect(hidden.summary).toMatch(/1033/);

    const tunnelOnly = diagnoseLocal({
      localHttpStatus: 200,
      heartbeatAgeMs: 1000,
      publicStatus: 530,
      publicBody: '1033',
    });
    expect(tunnelOnly.state).toBe('tunnel_down');
    expect(tunnelOnly.serverListening).toBe(true);
  });

  it('reports server_up with the unreachable guide', () => {
    const status = buildBridgeStatus({ pid: 9, startedAtMs: 1_000, now: 1_500, port: 3847 });
    expect(status.state).toBe('server_up');
    expect(status.uptimeMs).toBe(500);
    expect(status.ifUnreachable.cloudflare_1033_or_http_530).toMatch(/tunnel_down/);
    expect(status.ifUnreachable.http_502_or_504).toMatch(/server_down/);
    expect(status.ifUnreachable.fetch_failed_or_dns).toMatch(/host_offline/);
  });
});

describe('allowlist paths', () => {
  it('keeps Windows drive letters and rejects a prefix that is not a directory', () => {
    expect(lexicalPath('C:\\Src\\App\\', true)).toBe('C:/src/app');
    expect(isPathInside('C:\\Src\\App', 'C:/src/app/src/main.ts')).toBe(true);
    expect(isPathInside('C:\\Src\\App', 'C:\\Src\\App-evil\\x')).toBe(false);
    expect(isPathInside('C:\\Src\\App', 'C:\\Src\\App\\..\\Other')).toBe(false);
    expect(isPathAllowed('/srv/ok/nested', ['/srv/ok', '/srv/other'])).toBe(true);
    expect(isPathAllowed('/srv/okay', ['/srv/ok'])).toBe(false);
  });

  it('fails closed for an unknown caller when the file has callers', () => {
    expect(
      resolveCallerPaths({
        caller: 'stranger',
        file: { callers: { grok: ['D:\\work\\app'] } },
      }),
    ).toEqual({ enforced: true, paths: [] });
    expect(
      resolveCallerPaths({
        caller: 'grok',
        file: { callers: { grok: ['D:\\work\\app'] } },
        envPaths: ['/fallback'],
      }).paths,
    ).toEqual(['D:\\work\\app']);
    expect(resolveCallerPaths({ caller: 'default', file: null })).toEqual({
      enforced: false,
      paths: [],
    });
  });
});

describe('git porcelain and rss', () => {
  it('parses dirty paths and renames', () => {
    const files = parsePorcelain(' M src/a.ts\n?? new.txt\nR  old.ts -> src/new.ts\n');
    expect(files).toEqual(['src/a.ts', 'new.txt', 'src/new.ts']);
  });

  it('reads HEAD and dirty files from an injected runner', () => {
    const snap = readGitSnapshot('/repo', (cwd, args) => {
      expect(cwd).toBe('/repo');
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc123\n', stderr: '' };
      return { ok: true, stdout: ' M README.md\n', stderr: '' };
    });
    expect(snap).toEqual({ head: 'abc123', dirtyFiles: ['README.md'] });
  });

  it('parses VmRSS', () => {
    expect(parseProcStatusRss('Name:\twingman\nVmRSS:\t  2048 kB\n')).toBe(2048 * 1024);
  });
});

describe('windows task and codex exec argv', () => {
  it('restarts on failure and never passes --new-token', () => {
    const plan = buildWindowsTaskPlan({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\src\\wingman\\dist\\pair.js',
    });
    expect(plan.xml).toContain('<RestartOnFailure>');
    expect(plan.xml).toContain('<LogonTrigger>');
    expect(plan.xml).toContain('<BootTrigger>');
    expect(plan.xml).toContain('PT0S');
    expect(plan.xml).toContain('<Arguments>');
    expect(plan.xml.split('<Arguments>')[1]?.split('</Arguments>')[0]).not.toContain('--new-token');
    expect(plan.tokenFlag).toBeNull();
    expect(plan.xml).toContain('pair.js');
    expect(deriveSessionState({ running: true, approvalCount: 1 })).toBe('awaiting_approval');
    expect(deriveSessionState({ running: false, approvalCount: 0, error: 'boom' })).toBe('errored');
    expect(memoryNote(true, 10)).toMatch(/shared/);
  });

  it('uses current exec flags and stdin for a multi-line prompt', () => {
    expect(() => parseCodexSandbox('full-auto')).toThrow(/0\.166/);
    const plan = buildCodexExecArgs({
      cwd: 'C:\\src\\app',
      sandbox: 'workspace-write',
      model: 'gpt-5.2',
      resumeSessionId: 'thr_123',
    });
    expect(plan.shell).toBe(false);
    expect(plan.promptOnStdin).toBe(true);
    expect(plan.args).not.toContain('--full-auto');
    expect(plan.args).toEqual([
      'exec',
      'resume',
      '--cd',
      'C:\\src\\app',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-5.2',
      '--json',
      '--color',
      'never',
      'thr_123',
      '-',
    ]);
    expect(StartCodexExecSchema.safeParse({ prompt: 'x', cwd: 'C:\\src', sandbox: 'full-auto' }).success).toBe(
      false,
    );
  });
});

class FakeChild extends EventEmitter {
  pid = 4321;
  written = '';
  killed?: string;
  stdin = {
    write: (chunk: string) => {
      this.written += chunk;
    },
    end: () => undefined,
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(signal?: NodeJS.Signals) {
    this.killed = signal;
    this.emit('exit', null);
    return true;
  }
}

function stubProvider(name: ProviderName): SessionProvider {
  return {
    name,
    async listSessions() {
      return [];
    },
    async readTranscript() {
      throw new Error('no transcript');
    },
    async sendMessage() {
      throw new Error('no send');
    },
    async interrupt() {
      return { sessionId: 'x', status: 'interrupted' };
    },
  };
}

describe('headless runs and session tools', () => {
  let child: FakeChild;
  const previousClaude = process.env.CLAUDE_MOCK;

  beforeEach(() => {
    child = new FakeChild();
    process.env.CLAUDE_MOCK = '1';
  });

  afterEach(() => {
    if (previousClaude === undefined) delete process.env.CLAUDE_MOCK;
    else process.env.CLAUDE_MOCK = previousClaude;
  });

  function spawnFn(): ReturnType<SpawnFn> {
    return child;
  }

  it('spawns codex exec without a shell and tails stdout', async () => {
    const providers = createProviders();
    const runs = new HeadlessRuns(providers, spawnFn as SpawnFn, () => 8192);
    const run = runs.startCodex({
      prompt: 'line one\nline two',
      cwd: 'C:\\src\\app',
      sandbox: 'read-only',
      model: 'gpt-5.2',
    });
    expect(run.shell).toBe(false);
    expect(run.promptDelivery).toBe('stdin');
    expect(child.written).toBe('line one\nline two');
    expect(run.pid).toBe(4321);
    child.stdout.emit('data', '{"type":"thread.started","thread_id":"thr_abc"}\nworking\n');
    child.emit('exit', 0);
    const polled = runs.get(run.id, 10);
    expect(polled?.status).toBe('completed');
    expect(polled?.sessionId).toBe('thr_abc');
    expect(polled?.tail).toContain('working');
    expect(polled?.memoryBytes).toBe(8192);
  });

  it('kills a codex exec pid and stops a claude run by session', async () => {
    const providers = createProviders();
    const runs = new HeadlessRuns(providers, spawnFn as SpawnFn, () => 100);
    const handlers = createToolHandlers(providers, {
      runs,
      rss: () => 100,
      git: () => ({ ok: true, stdout: 'deadbeef\n', stderr: '' }),
      allowlist: () => ({ caller: 'default', enforced: false, paths: [] }),
    });
    const started = await handlers.start_codex_exec({
      prompt: 'do the thing',
      cwd: '/srv/app',
      sandbox: 'workspace-write',
    });
    const body = JSON.parse(started.content[0]!.text) as { runId: string };
    const stopped = await handlers.stop({ run_id: body.runId, force: true });
    const stopBody = JSON.parse(stopped.content[0]!.text) as { runs: Array<{ status: string }> };
    expect(child.killed).toBe('SIGKILL');
    expect(stopBody.runs[0]?.status).toBe('killed');

    const headless = await handlers.run_headless({
      prompt: 'fix the flaky test\nstill line two',
      cwd: '/srv/app',
      max_turns: 12,
      permission_mode: 'acceptEdits',
    });
    const runBody = JSON.parse(headless.content[0]!.text) as {
      runId: string;
      sessionId: string;
      promptDelivery: string;
      shell: boolean;
    };
    expect(runBody.promptDelivery).toBe('sdk-string');
    expect(runBody.shell).toBe(false);
    let status = '';
    for (let i = 0; i < 30; i++) {
      const polled = await handlers.get_run({ run_id: runBody.runId, tail_lines: 20 });
      const parsed = JSON.parse(polled.content[0]!.text) as { status: string; tail?: string };
      status = parsed.status;
      if (status === 'completed' && parsed.tail?.includes('Received')) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(status).toBe('completed');

    const session = await handlers.get_status({ provider: 'claude', session_id: runBody.sessionId });
    const sessionBody = JSON.parse(session.content[0]!.text) as {
      state: string;
      git: { head?: string };
      model?: string;
      memory: { shared: boolean };
    };
    expect(sessionBody.state).toBe('idle');
    expect(sessionBody.git.head).toBe('deadbeef');
    expect(sessionBody.memory.shared).toBe(true);
  });
});

describe('allowlist on list_sessions and get_status', () => {
  function registry(codex: SessionProvider): ProviderRegistry {
    const claude = stubProvider('claude');
    const muse = stubProvider('muse');
    const all = [codex, claude, muse];
    return {
      codex,
      claude,
      muse,
      get(name) {
        return all.find((provider) => provider.name === name) ?? codex;
      },
      all: () => all,
    };
  }

  it('hides sessions outside the caller roots and reports approval state', async () => {
    const sessions: SessionSummary[] = [
      { id: 'in', provider: 'codex', cwd: '/srv/ok/app', status: 'idle', updatedAt: 10 },
      { id: 'out', provider: 'codex', cwd: '/srv/secret', status: 'idle' },
      { id: 'stub', provider: 'codex', status: 'not_enabled', preview: 'missing binary' },
    ];
    const activity: Record<string, SessionActivity> = {
      in: {
        running: true,
        approvalCount: 1,
        prompt: 'please run git status',
        model: 'gpt-5.2',
        pid: 77,
        sharedProcess: true,
      },
    };
    const codex: SessionProvider = {
      ...stubProvider('codex'),
      async listSessions() {
        return sessions;
      },
      async getSession(id) {
        const session = sessions.find((item) => item.id === id);
        return session ? { ...session } : null;
      },
      async listApprovals(id) {
        return {
          sessionId: id,
          approvals:
            activity[id]?.approvalCount
              ? [{ id: 'a', sessionId: id, kind: 'command' as const, requestedAt: 1 }]
              : [],
        };
      },
      activity(id) {
        return (
          activity[id] ?? {
            running: false,
            approvalCount: 0,
            sharedProcess: true,
          }
        );
      },
    };
    const handlers = createToolHandlers(registry(codex), {
      allowlist: (caller) => ({
        caller: caller ?? 'grok',
        ...resolveCallerPaths({
          caller: caller ?? 'grok',
          file: { callers: { grok: ['/srv/ok'] } },
        }),
      }),
      git: (_cwd, args) =>
        args[0] === 'rev-parse'
          ? { ok: true, stdout: 'abc\n', stderr: '' }
          : { ok: true, stdout: ' M dirty.ts\n', stderr: '' },
      rss: () => 4096,
    });

    const listed = await handlers.list_sessions({ provider: 'codex', caller: 'grok' });
    const ids = (JSON.parse(listed.content[0]!.text) as { sessions: SessionSummary[] }).sessions.map(
      (session) => session.id,
    );
    expect(ids).toEqual(['in', 'stub']);

    const status = await handlers.get_status({ provider: 'codex', session_id: 'in', caller: 'grok' });
    const body = JSON.parse(status.content[0]!.text) as {
      state: string;
      pendingPrompt?: string;
      model?: string;
      git: { head?: string; dirtyFiles: string[] };
      memory: { bytes: number | null };
    };
    expect(body.state).toBe('awaiting_approval');
    expect(body.pendingPrompt).toBe('please run git status');
    expect(body.model).toBe('gpt-5.2');
    expect(body.git).toEqual({ head: 'abc', dirtyFiles: ['dirty.ts'] });
    expect(body.memory.bytes).toBe(4096);

    const denied = await handlers.get_status({ provider: 'codex', session_id: 'out', caller: 'grok' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toMatch(/allowlist/);
  });
});
