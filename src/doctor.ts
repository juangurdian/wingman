#!/usr/bin/env node
/**
 * Wingman doctor — health check for your environment.
 * Checks:
 * - Node.js version (20+ required)
 * - Config file (~/.wingman/config.json)
 * - Port availability
 * - Claude Agent SDK availability (unless CLAUDE_MOCK=1)
 * - Codex binary on PATH (unless CODEX_MOCK=1)
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { configPath, loadConfig, resolvePort } from './config.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= 20) {
    return {
      name: 'Node.js version',
      status: 'pass',
      message: `Node.js ${version} (20+ required)`,
    };
  }

  return {
    name: 'Node.js version',
    status: 'fail',
    message: `Node.js ${version} is too old (20+ required)`,
    fix: 'Install Node.js 20 or later: https://nodejs.org/',
  };
}

export async function checkConfig(): Promise<CheckResult> {
  const path = configPath();
  const config = loadConfig();

  if (!existsSync(path)) {
    return {
      name: 'Config file',
      status: 'warn',
      message: `Config not found at ${path}`,
      fix: 'Run `npm run pair` to generate config',
    };
  }

  if (!config?.token) {
    return {
      name: 'Config file',
      status: 'warn',
      message: `Config exists but missing token`,
      fix: 'Run `npm run pair` to regenerate config',
    };
  }

  return {
    name: 'Config file',
    status: 'pass',
    message: `Config found at ${path}`,
  };
}

export async function checkPort(): Promise<CheckResult> {
  const port = resolvePort();

  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve({
          name: 'Port availability',
          status: 'warn',
          message: `Port ${port} is already in use`,
          fix: `Set WINGMAN_PORT to a different port, or stop the process using port ${port}`,
        });
      } else {
        resolve({
          name: 'Port availability',
          status: 'fail',
          message: `Cannot bind to port ${port}: ${err.message}`,
          fix: 'Check your network configuration or try a different port',
        });
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve({
          name: 'Port availability',
          status: 'pass',
          message: `Port ${port} is available`,
        });
      });
    });

    server.listen(port, '127.0.0.1');
  });
}

export async function checkClaudeSdk(): Promise<CheckResult> {
  if (process.env.CLAUDE_MOCK === '1' || process.env.CLAUDE_MOCK === 'true') {
    return {
      name: 'Claude Agent SDK',
      status: 'pass',
      message: 'CLAUDE_MOCK=1 (SDK check skipped)',
    };
  }

  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');

    if (typeof sdk.listSessions !== 'function') {
      return {
        name: 'Claude Agent SDK',
        status: 'warn',
        message: 'SDK imported but listSessions not available',
        fix: 'Update to latest @anthropic-ai/claude-agent-sdk',
      };
    }

    return {
      name: 'Claude Agent SDK',
      status: 'pass',
      message: 'Claude Agent SDK available',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('Native CLI binary') || msg.includes('ENOENT')) {
      return {
        name: 'Claude Agent SDK',
        status: 'warn',
        message: 'Claude Code CLI not installed (SDK native binary missing)',
        fix: 'Install Claude Code: https://code.claude.com/docs/en/installation or set CLAUDE_MOCK=1',
      };
    }

    return {
      name: 'Claude Agent SDK',
      status: 'fail',
      message: `Claude SDK error: ${msg}`,
      fix: 'Install or fix Claude Code installation, or set CLAUDE_MOCK=1',
    };
  }
}

export async function checkCodexBinary(): Promise<CheckResult> {
  if (process.env.CODEX_MOCK === '1' || process.env.CODEX_MOCK === 'true') {
    return {
      name: 'Codex binary',
      status: 'pass',
      message: 'CODEX_MOCK=1 (binary check skipped)',
    };
  }

  const bin = process.env.CODEX_BIN?.trim() || 'codex';

  return new Promise((resolve) => {
    const proc = spawn(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });

    let stdout = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        resolve({
          name: 'Codex binary',
          status: 'warn',
          message: `Codex binary not found: ${bin}`,
          fix: 'Install Codex CLI and ensure `codex` is on PATH, or set CODEX_MOCK=1',
        });
      } else {
        resolve({
          name: 'Codex binary',
          status: 'fail',
          message: `Codex error: ${err.message}`,
          fix: 'Check Codex installation, or set CODEX_MOCK=1',
        });
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        const version = stdout.trim().split('\n')[0] || 'version unknown';
        resolve({
          name: 'Codex binary',
          status: 'pass',
          message: `Codex available: ${version}`,
        });
      } else {
        resolve({
          name: 'Codex binary',
          status: 'warn',
          message: `Codex exited with code ${code}`,
          fix: 'Codex may need authentication or setup',
        });
      }
    });
  });
}

export async function runAllChecks(): Promise<CheckResult[]> {
  const checks = await Promise.all([
    checkNodeVersion(),
    checkConfig(),
    checkPort(),
    checkClaudeSdk(),
    checkCodexBinary(),
  ]);

  return checks;
}

function printResults(results: CheckResult[]): void {
  const icons = {
    pass: '✓',
    warn: '⚠',
    fail: '✗',
  };

  const colors = {
    pass: '\x1b[32m',
    warn: '\x1b[33m',
    fail: '\x1b[31m',
    reset: '\x1b[0m',
  };

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                       Wingman Doctor                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  let hasIssues = false;
  const fixes: string[] = [];

  for (const result of results) {
    const icon = icons[result.status];
    const color = colors[result.status];
    console.log(`${color}${icon}${colors.reset} ${result.name}: ${result.message}`);

    if (result.fix) {
      hasIssues = true;
      fixes.push(`  → ${result.name}: ${result.fix}`);
    }
  }

  if (fixes.length > 0) {
    console.log('\n────────────────────────────────────────────────────────────────────');
    console.log('Next steps:\n');
    for (const fix of fixes) {
      console.log(fix);
    }
  }

  console.log('\n────────────────────────────────────────────────────────────────────');

  const passCount = results.filter((r) => r.status === 'pass').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;
  const failCount = results.filter((r) => r.status === 'fail').length;

  if (failCount > 0) {
    console.log(`\n${colors.fail}${failCount} check(s) failed.${colors.reset} Fix before running Wingman.`);
  } else if (warnCount > 0) {
    console.log(
      `\n${colors.warn}${warnCount} warning(s).${colors.reset} ` +
        `Wingman may work in mock mode, but fix for full functionality.`,
    );
  } else {
    console.log(`\n${colors.pass}All ${passCount} checks passed!${colors.reset} Ready to run \`npm run pair\`.`);
  }

  console.log('');
}

async function main(): Promise<void> {
  const results = await runAllChecks();
  printResults(results);

  const hasFailure = results.some((r) => r.status === 'fail');
  process.exit(hasFailure ? 1 : 0);
}

const isMain =
  process.argv[1]?.endsWith('doctor.ts') ||
  process.argv[1]?.endsWith('doctor.js') ||
  process.argv[1]?.includes('/doctor');

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
