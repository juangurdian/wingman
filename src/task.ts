#!/usr/bin/env node
/**
 * Install Wingman as a Windows scheduled task.
 * On other systems this prints the XML and the schtasks command and does not register anything.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import {
  configDir,
  generateToken,
  loadConfig,
  resolveHost,
  resolvePort,
  safeErrorText,
  saveConfig,
} from './config.js';
import { buildWindowsTaskPlan, type TaskTunnel } from './windows-task.js';

function pairScriptPath(): string {
  const running = process.argv[1] ?? '';
  if (running.endsWith('task.ts')) return join(process.cwd(), 'src', 'pair.ts');
  return join(running, '..', 'pair.js');
}

function ensureStableToken(): { created: boolean; path: string } {
  const existing = loadConfig();
  if (existing?.token) {
    return { created: false, path: join(configDir(), 'config.json') };
  }
  const path = saveConfig({
    token: generateToken(),
    host: resolveHost(),
    port: resolvePort(),
    mcpPath: '/mcp',
    createdAt: new Date().toISOString(),
  });
  return { created: true, path };
}

function parseTunnel(argv: string[]): TaskTunnel {
  const idx = argv.indexOf('--tunnel');
  if (idx < 0) return 'none';
  const value = argv[idx + 1];
  if (value === 'tailscale' || value === 'quick' || value === 'none') return value;
  throw new Error('--tunnel expects tailscale, quick, or none');
}

function parseBin(argv: string[]): string | undefined {
  const idx = argv.indexOf('--tailscale-bin');
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function printHelp(): void {
  console.log(`Usage: wingman-task <install|uninstall|print-xml|status> [--tunnel tailscale|quick|none] [--tailscale-bin PATH]

install     Write the task XML. On Windows, register it with schtasks.
            The task runs at user logon and at boot, and restarts one minute after a crash.
            It starts wingman-pair with no --new-token, so the bearer token stays put.
            --tunnel tailscale also passes --ensure-tunnel tailscale. Funnel --bg persists
            in tailscaled, so the task only republishes the port when it is not active.
            --tunnel quick starts a Cloudflare quick tunnel. That URL changes every start.
uninstall   On Windows, delete the Wingman scheduled task.
print-xml   Print the task XML.
status      On Windows, query the Wingman task.

The token file is %USERPROFILE%\\.wingman\\config.json (or ~/.wingman/config.json).
`);
}

export function installTask(opts?: {
  apply?: boolean;
  nodePath?: string;
  scriptPath?: string;
  tunnel?: TaskTunnel;
  tailscaleBin?: string;
}): {
  applied: boolean;
  xmlPath: string;
  plan: ReturnType<typeof buildWindowsTaskPlan>;
  tokenCreated: boolean;
} {
  const token = ensureStableToken();
  const plan = buildWindowsTaskPlan({
    nodePath: opts?.nodePath ?? process.execPath,
    scriptPath: opts?.scriptPath ?? pairScriptPath(),
    tunnel: opts?.tunnel,
    tailscaleBin: opts?.tailscaleBin,
  });
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const xmlPath = join(dir, 'wingman-task.xml');
  writeFileSync(xmlPath, plan.xml, { encoding: 'utf8', mode: 0o600 });

  const apply = opts?.apply ?? platform() === 'win32';
  if (apply) {
    const result = spawnSync('schtasks', ['/Create', '/TN', plan.taskName, '/XML', xmlPath, '/F'], {
      encoding: 'utf8',
      shell: false,
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'schtasks /Create failed').trim());
    }
  }
  return { applied: apply, xmlPath, plan, tokenCreated: token.created };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'print-xml') {
    const plan = buildWindowsTaskPlan({
      nodePath: process.execPath,
      scriptPath: pairScriptPath(),
      tunnel: parseTunnel(process.argv.slice(2)),
      tailscaleBin: parseBin(process.argv.slice(2)),
    });
    process.stdout.write(plan.xml);
    return;
  }

  if (cmd === 'install') {
    const result = installTask({
      tunnel: parseTunnel(process.argv.slice(2)),
      tailscaleBin: parseBin(process.argv.slice(2)),
    });
    console.log(
      JSON.stringify(
        {
          applied: result.applied,
          xmlPath: result.xmlPath,
          taskName: result.plan.taskName,
          tokenCreated: result.tokenCreated,
          command: `${result.plan.nodePath} "${result.plan.scriptPath}"`,
          passedNewToken: false,
          tunnel: result.plan.tunnel,
          notes: result.plan.notes,
          reason: result.applied
            ? 'Registered with schtasks.'
            : 'This machine is not Windows. XML was written. Copy it to the host and run schtasks /Create /TN Wingman /XML <file> /F.',
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === 'uninstall' || cmd === 'status') {
    if (platform() !== 'win32') {
      console.log(
        JSON.stringify({
          ok: false,
          summary: `wingman-task ${cmd} only talks to schtasks on Windows.`,
        }),
      );
      return;
    }
    const args =
      cmd === 'uninstall'
        ? ['/Delete', '/TN', 'Wingman', '/F']
        : ['/Query', '/TN', 'Wingman', '/FO', 'LIST', '/V'];
    const result = spawnSync('schtasks', args, { encoding: 'utf8', shell: false });
    process.stdout.write(result.stdout || '');
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
    return;
  }

  printHelp();
  process.exitCode = 1;
}

const isMain =
  process.argv[1]?.endsWith('task.ts') ||
  process.argv[1]?.endsWith('task.js') ||
  process.argv[1]?.includes('/task');

if (isMain) {
  main().catch((err) => {
    console.error(safeErrorText(err, [loadConfig()?.token]));
    process.exit(1);
  });
}
