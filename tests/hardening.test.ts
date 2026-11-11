import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  formatRotationMessage,
  generateToken,
  isWeakToken,
  maskToken,
  redactToken,
  resolveHost,
  rotateStoredToken,
  saveConfig,
  weakTokenReason,
} from '../src/config.js';
import { collectAllowedHosts, mcpExpressOptions } from '../src/bind.js';
import { claudeAgentsSpawnPlan } from '../src/claude-inbox.js';
import { resolveCommandOnPath } from '../src/spawn-command.js';
import {
  buildBridgeStatus,
  describeHeartbeat,
  diagnoseLocal,
  HEARTBEAT_STALE_MS,
} from '../src/reachability.js';
import { buildWindowsTaskPlan } from '../src/windows-task.js';
import {
  executeFunnel,
  funnelConnectorUrl,
  FUNNEL_NOT_ENABLED,
  parseFunnelFailure,
  parseTailscaleStatus,
  readFunnelDiagnosis,
  resolveTailscaleBin,
  type CommandResult,
  type CommandRunner,
} from '../src/tailscale.js';
import { ensureConfiguredTunnel } from '../src/ensure-tunnel.js';
import {
  decideInboxDelivery,
  deliverInteractiveInbox,
  watchInboxPhase,
} from '../src/inbox-pickup.js';
import { approvalStallFields, APPROVAL_STALL_MS_DEFAULT } from '../src/session-status.js';
import { createToolHandlers } from '../src/mcp/tools.js';
import { printPairInstructions } from '../src/pair.js';
import type { ProviderName, ProviderRegistry, SessionProvider, SessionSummary } from '../src/providers/index.js';

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wingman-hardening-'));
  dirs.push(dir);
  vi.stubEnv('WINGMAN_CONFIG_DIR', dir);
  return dir;
}

describe('token masking and rotation', () => {
  it('never puts the full token in pair output unless show-token is set', () => {
    const token = 'super-secret-token-value-ABCDEF';
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.map(String).join(' '));
    });
    printPairInstructions(
      { token, host: '127.0.0.1', port: 3847, mcpPath: '/mcp', createdAt: '2026-01-01T00:00:00.000Z' },
      'http://127.0.0.1:3847/mcp',
      false,
    );
    spy.mockRestore();
    const text = lines.join('\n');
    expect(text).not.toContain(token);
    expect(text).toContain(maskToken(token));
  });

  it('redacts a token that leaks into an error string', () => {
    const token = generateToken();
    expect(redactToken(`refused ${token} from client`, token)).toBe(`refused ${maskToken(token)} from client`);
    expect(redactToken('no secret here', token)).toBe('no secret here');
  });

  it('warns on smoke- and other obvious test tokens', () => {
    expect(weakTokenReason('smoke-abc')).toBe('starts with smoke-');
    expect(isWeakToken('test-token')).toBe(true);
    expect(isWeakToken('changeme')).toBe(true);
    expect(isWeakToken(generateToken())).toBe(false);
  });

  it('rotates the config file and masks the new token', () => {
    const dir = tempConfig();
    saveConfig({
      token: 'smoke-old-token-value',
      host: '127.0.0.1',
      port: 3847,
      mcpPath: '/mcp',
      createdAt: '2026-01-01T00:00:00.000Z',
      tunnelHost: 'box.tailnet.ts.net',
    });
    const rotated = rotateStoredToken('2026-11-11T00:00:00.000Z');
    const text = formatRotationMessage({
      path: rotated.path,
      token: rotated.token,
      showToken: false,
      previousWasWeak: rotated.previousWasWeak,
      weakReason: rotated.weakReason,
    });
    expect(rotated.previousWasWeak).toBe(true);
    expect(text).not.toContain(rotated.token);
    expect(text).not.toContain('smoke-old-token-value');
    expect(text).toContain('starts with smoke-');
    expect(text).toContain(maskToken(rotated.token));
    expect(text).toMatch(/restart/i);
    const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { token: string; tunnelHost: string };
    expect(saved.token).toBe(rotated.token);
    expect(saved.token).not.toBe('smoke-old-token-value');
    expect(saved.tunnelHost).toBe('box.tailnet.ts.net');
    const shown = formatRotationMessage({ path: rotated.path, token: rotated.token, showToken: true });
    expect(shown).toContain(rotated.token);
  });

  it('doctor mentions a weak token without printing it', async () => {
    const dir = tempConfig();
    const token = 'smoke-doctor-token-value';
    saveConfig({
      token,
      host: '127.0.0.1',
      port: 3847,
      mcpPath: '/mcp',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(
      join(dir, 'heartbeat.json'),
      `${JSON.stringify({ pid: 1, port: 3847, startedAt: old, beatAt: old })}\n`,
    );
    const { checkTokenSecurity, checkHeartbeat } = await import('../src/doctor.js');
    const security = await checkTokenSecurity();
    expect(security.status).toBe('warn');
    expect(security.message).not.toContain(token);
    expect(security.message).toContain('smoke-');
    const beat = await checkHeartbeat();
    expect(beat.status).toBe('warn');
    expect(beat.message).toMatch(/stale|15 seconds|not recording|old/i);
  });
});

describe('bind address and DNS rebinding', () => {
  it('defaults the listen host to loopback and allowlists the funnel hostname', () => {
    delete process.env.WINGMAN_HOST;
    delete process.env.SESSION_BRIDGE_HOST;
    expect(resolveHost()).toBe('127.0.0.1');
    const hosts = collectAllowedHosts({
      listenHost: '127.0.0.1',
      tunnelHost: 'pearlwolf.tailnet.ts.net.',
      publicUrl: 'https://wingman.example.com/mcp',
      envAllowed: 'extra.example, localhost',
    });
    expect(hosts).toContain('127.0.0.1');
    expect(hosts).toContain('localhost');
    expect(hosts).toContain('[::1]');
    expect(hosts).toContain('pearlwolf.tailnet.ts.net');
    expect(hosts).toContain('wingman.example.com');
    expect(hosts).toContain('extra.example');
    expect(hosts).not.toContain('0.0.0.0');
    const open = mcpExpressOptions('0.0.0.0', hosts);
    expect(open.host).toBe('0.0.0.0');
    expect(open.allowedHosts).toEqual(hosts);
  });

  it('rejects a foreign Host and accepts the funnel hostname', async () => {
    const hosts = collectAllowedHosts({
      listenHost: '127.0.0.1',
      tunnelHost: 'pearlwolf.tailnet.ts.net',
    });
    const app = createMcpExpressApp(mcpExpressOptions('127.0.0.1', hosts));
    app.get('/probe', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const status = (hostHeader: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/probe', method: 'GET', headers: { Host: hostHeader } },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await status('127.0.0.1')).toBe(200);
      expect(await status('pearlwolf.tailnet.ts.net')).toBe(200);
      expect(await status('evil.example')).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('tailscale funnel', () => {
  it('reads the MagicDNS name and the stable connector URL', () => {
    expect(parseTailscaleStatus('{"Self":{"DNSName":"pearlwolf.tailnet.ts.net.","Online":true}}')).toEqual({
      dnsName: 'pearlwolf.tailnet.ts.net',
      online: true,
    });
    expect(funnelConnectorUrl('pearlwolf.tailnet.ts.net.')).toBe('https://pearlwolf.tailnet.ts.net/mcp');
  });

  it('reports Funnel not enabled on tailnet with the approval link', () => {
    const text = [
      'Error: funnel is not enabled on your tailnet',
      'To enable, visit:',
      '        https://login.tailscale.com/f/funnel?node=n123',
    ].join('\n');
    const failure = parseFunnelFailure(text);
    expect(failure.notEnabled).toBe(true);
    expect(failure.approvalUrl).toBe('https://login.tailscale.com/f/funnel?node=n123');
    const calls: string[][] = [];
    const run: CommandRunner = (_command, args) => {
      calls.push(args);
      if (args[0] === 'status') {
        return { status: 0, stdout: '{"Self":{"DNSName":"pearlwolf.tailnet.ts.net."}}', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: text };
    };
    const report = readFunnelDiagnosis({ port: 3847, bin: 'tailscale', run });
    expect(report.summary).toContain(FUNNEL_NOT_ENABLED);
    expect(report.summary).toContain('https://login.tailscale.com/f/funnel?node=n123');
    expect(report.enabled).toBe(false);
    expect(calls.some((args) => args[0] === 'funnel' && args[1] === '--bg')).toBe(false);
  });

  it('skips funnel --bg when the port is already published', () => {
    const serve = JSON.stringify({
      AllowFunnel: { 'pearlwolf.tailnet.ts.net:443': true },
      Web: { 'pearlwolf.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3847' } } } },
    });
    const calls: string[][] = [];
    const run: CommandRunner = (_command, args) => {
      calls.push(args);
      if (args.join(' ') === 'status --json') {
        return { status: 0, stdout: '{"Self":{"DNSName":"pearlwolf.tailnet.ts.net.","Online":true}}', stderr: '' };
      }
      if (args.join(' ') === 'serve status --json') return { status: 0, stdout: serve, stderr: '' };
      return { status: 0, stdout: 'Funnel on', stderr: '' };
    };
    const report = executeFunnel({ port: 3847, bin: 'tailscale', run });
    expect(report.active).toBe(true);
    expect(report.started).toBe(false);
    expect(report.connectorUrl).toBe('https://pearlwolf.tailnet.ts.net/mcp');
    expect(calls.some((args) => args[0] === 'funnel' && args.includes('--bg'))).toBe(false);
  });

  it('uses a Windows tailscale.exe path when it exists', () => {
    const bin = resolveTailscaleBin({
      platform: 'win32',
      exists: (path) => path === 'C:\\Program Files\\Tailscale\\tailscale.exe',
    });
    expect(bin).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
    expect(resolveTailscaleBin({ explicit: 'D:\\tailscale.exe', platform: 'win32', exists: () => false })).toBe(
      'D:\\tailscale.exe',
    );
  });

  it('checks funnel from the scheduled-task ensure path and keeps the quick tunnel option', () => {
    tempConfig();
    const calls: string[][] = [];
    const run: CommandRunner = (_command, args) => {
      calls.push(args);
      if (args[0] === 'funnel' && args[1] === '--bg') return { status: 0, stdout: '', stderr: '' } satisfies CommandResult;
      if (args.join(' ') === 'status --json') {
        return { status: 0, stdout: '{"Self":{"DNSName":"pearlwolf.tailnet.ts.net."}}', stderr: '' };
      }
      if (args.join(' ') === 'serve status --json') {
        const active = calls.some((item) => item[0] === 'funnel' && item[1] === '--bg');
        return {
          status: 0,
          stdout: active
            ? JSON.stringify({ AllowFunnel: { h: true }, Web: { h: { Proxy: 'http://127.0.0.1:3847' } } })
            : '{}',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const ensured = ensureConfiguredTunnel({
      mode: 'tailscale',
      port: 3847,
      host: '127.0.0.1',
      tailscaleBin: 'tailscale',
      run,
    });
    expect(ensured.connectorUrl).toBe('https://pearlwolf.tailnet.ts.net/mcp');
    expect(calls.some((args) => args[0] === 'funnel' && args[1] === '--bg' && args[2] === '3847')).toBe(true);
    const quick = ensureConfiguredTunnel({
      mode: 'quick',
      port: 3847,
      host: '127.0.0.1',
      spawnQuick: (plan) => {
        expect(plan.shell).toBe(false);
        expect(plan.args).toEqual(['tunnel', '--url', 'http://127.0.0.1:3847']);
        return { pid: 42 };
      },
    });
    expect(quick.summary).toMatch(/quick tunnel/i);
    expect(quick.summary).toMatch(/changes every start/);
  });
});

describe('heartbeat and approval stall', () => {
  it('flags a heartbeat older than five minutes', () => {
    const fresh = describeHeartbeat(15_000);
    expect(fresh.heartbeatStale).toBe(false);
    expect(fresh.heartbeatWarning).toBeUndefined();
    const stale = describeHeartbeat(HEARTBEAT_STALE_MS + 1);
    expect(stale.heartbeatStale).toBe(true);
    expect(stale.heartbeatWarning).toMatch(/15 seconds/);
    expect(stale.heartbeatWarning).toMatch(/does not by itself mean the tunnel is down/);
    const missing = describeHeartbeat(null);
    expect(missing.heartbeatStale).toBe(true);
    const status = buildBridgeStatus({ pid: 9, startedAtMs: 0, now: 10, heartbeatAgeMs: HEARTBEAT_STALE_MS + 5 });
    expect(status.heartbeatStale).toBe(true);
    expect(status.state).toBe('server_up');
    const local = diagnoseLocal({ localHttpStatus: 200, heartbeatAgeMs: HEARTBEAT_STALE_MS + 5 });
    expect(local.heartbeatStale).toBe(true);
    expect(local.state).toBe('server_up');
  });

  it('flags an approval that has been pending for ten minutes', async () => {
    const now = 1_000_000;
    const fresh = approvalStallFields([{ requestedAt: now - 1000 }], now, APPROVAL_STALL_MS_DEFAULT);
    expect(fresh.stalled_on_approval).toBe(false);
    expect(fresh.pendingApprovalAgeMs).toBe(1000);
    const stuck = approvalStallFields([{ requestedAt: now - APPROVAL_STALL_MS_DEFAULT - 1 }], now);
    expect(stuck.stalled_on_approval).toBe(true);

    const sessions: SessionSummary[] = [
      { id: 's1', provider: 'codex', cwd: '/work', status: 'idle' },
    ];
    const codex: SessionProvider = {
      name: 'codex',
      async listSessions() {
        return sessions;
      },
      async readTranscript() {
        return { sessionId: 's1', provider: 'codex', items: [] };
      },
      async sendMessage() {
        return { sessionId: 's1', status: 'completed' };
      },
      async interrupt() {
        return { sessionId: 's1', status: 'interrupted' };
      },
      async getSession(id) {
        return sessions.find((session) => session.id === id) ?? null;
      },
      async listApprovals(id) {
        return {
          sessionId: id,
          approvals: [{ id: 'a', sessionId: id, kind: 'command', requestedAt: Date.now() - 11 * 60 * 1000 }],
        };
      },
    };
    const empty = (name: ProviderName): SessionProvider => ({
      name,
      async listSessions() {
        return [];
      },
      async readTranscript() {
        throw new Error('no');
      },
      async sendMessage() {
        throw new Error('no');
      },
      async interrupt() {
        return { sessionId: 'x', status: 'interrupted' };
      },
    });
    const providers: ProviderRegistry = {
      codex,
      claude: empty('claude'),
      muse: empty('muse'),
      get(name) {
        return name === 'codex' ? codex : empty(name);
      },
      all: () => [codex],
    };
    const handlers = createToolHandlers(providers);
    const listed = await handlers.list_sessions({ provider: 'codex' });
    const body = JSON.parse(listed.content[0]!.text) as {
      sessions: Array<{ stalled_on_approval: boolean; pendingApprovalAgeMs: number }>;
    };
    expect(body.sessions[0]?.stalled_on_approval).toBe(true);
    expect(body.sessions[0]?.pendingApprovalAgeMs).toBeGreaterThan(APPROVAL_STALL_MS_DEFAULT);
    const status = await handlers.get_status({ provider: 'codex', session_id: 's1' });
    const statusBody = JSON.parse(status.content[0]!.text) as {
      stalled_on_approval: boolean;
      pendingApprovalAgeMs: number;
    };
    expect(statusBody.stalled_on_approval).toBe(true);
    expect(statusBody.pendingApprovalAgeMs).toBeGreaterThan(APPROVAL_STALL_MS_DEFAULT);
  });
});

describe('windows spawn and scheduled task', () => {
  it('resolves claude.cmd and keeps shell false', () => {
    const command = join('C:\\Tools', 'claude.CMD');
    const plan = claudeAgentsSpawnPlan({
      platform: 'win32',
      bin: 'claude',
      pathEnv: 'C:\\Tools',
      pathExt: '.EXE;.CMD',
      exists: (path) => path === command,
    });
    expect(plan.shell).toBe(false);
    expect(plan.args).toEqual(['agents', '--json']);
    expect(plan.command).toBe(command);
    expect(resolveCommandOnPath('claude', { platform: 'linux' })).toBe('claude');
  });

  it('can ensure a tailscale funnel without passing --new-token', () => {
    const plan = buildWindowsTaskPlan({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\src\\wingman\\dist\\pair.js',
      tunnel: 'tailscale',
      tailscaleBin: 'C:\\Program Files\\Tailscale\\tailscale.exe',
    });
    const args = plan.xml.split('<Arguments>')[1]?.split('</Arguments>')[0] ?? '';
    expect(args).toContain('--ensure-tunnel tailscale');
    expect(args).toContain('--tailscale-bin');
    expect(args).not.toContain('--new-token');
    expect(plan.tokenFlag).toBeNull();
    expect(plan.tunnel).toBe('tailscale');
    expect(plan.notes.join(' ')).toMatch(/tailscaled/);
    const quick = buildWindowsTaskPlan({
      nodePath: 'node',
      scriptPath: '/usr/lib/pair.js',
      tunnel: 'quick',
    });
    expect(quick.xml).toContain('--ensure-tunnel quick');
    expect(quick.xml).not.toContain('--new-token');
  });
});

describe('interactive inbox pickup', () => {
  it('reports queued_not_started when an idle session does not start, and refuses a mid-turn headless resume', async () => {
    const idle = decideInboxDelivery({ writeOk: true, before: 'idle', after: 'idle', fallback: 'none' });
    expect(idle.status).toBe('queued_not_started');
    expect(idle.inboxState).toBe('queued_not_started');
    expect(idle.headless).toBe(false);
    expect(idle.note).toMatch(/Enter/);

    const fallback = decideInboxDelivery({ writeOk: true, before: 'idle', after: 'idle', fallback: 'headless' });
    expect(fallback.headless).toBe(true);
    expect(fallback.note).toMatch(/second time/);

    const started = decideInboxDelivery({ writeOk: true, before: 'idle', after: 'mid_turn', fallback: 'headless' });
    expect(started.inboxState).toBe('started');
    expect(started.headless).toBe(false);

    const mid = decideInboxDelivery({ writeOk: true, before: 'mid_turn', after: 'mid_turn', fallback: 'headless' });
    expect(mid.inboxState).toBe('queued_mid_turn');
    expect(mid.headless).toBe(false);

    const midFail = decideInboxDelivery({ writeOk: false, before: 'mid_turn', after: 'mid_turn', fallback: 'headless' });
    expect(midFail.headless).toBe(false);
    expect(midFail.note).toMatch(/did not start a headless resume/);

    const unknown = decideInboxDelivery({ writeOk: true, before: 'unknown', after: 'unknown', fallback: 'headless' });
    expect(unknown.headless).toBe(false);
    expect(unknown.status).toBe('queued_not_started');
  });

  it('waits for the session to leave idle and then reports started', async () => {
    let clock = 0;
    let reads = 0;
    const delivery = await deliverInteractiveInbox({
      sessionId: 's',
      beforeStatus: 'idle',
      pickupMs: 1000,
      fallback: 'headless',
      send: async () => ({ delivered: true }),
      list: async () => [{ sessionId: 's', status: reads++ === 0 ? 'idle' : 'busy' }],
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(delivery.headless).toBe(false);
    expect(delivery.result.status).toBe('delivered_via_inbox');
    expect(delivery.result.inboxState).toBe('started');
  });

  it('stops watching when the timeout elapses without a turn', async () => {
    let clock = 0;
    const phase = await watchInboxPhase({
      sessionId: 's',
      timeoutMs: 500,
      pollMs: 250,
      list: async () => [{ sessionId: 's', status: 'idle' }],
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(phase).toBe('idle');
    expect(clock).toBeGreaterThanOrEqual(500);
  });
});
