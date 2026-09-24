#!/usr/bin/env node
/**
 * Wingman doctor — health check for your environment.
 * Checks:
 * - Node.js version (20+ required)
 * - Config file (~/.wingman/config.json)
 * - Port availability
 * - Claude Agent SDK availability (unless CLAUDE_MOCK=1)
 * - Codex binary on PATH (unless CODEX_MOCK=1)
 * - Codex model compatibility (ChatGPT vs API account)
 */

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  configPath,
  loadConfig,
  resolvePort,
  resolveCodexModel,
  isCodexModelApiOnly,
  CODEX_API_ONLY_MODELS,
  resolveHostId,
  resolveHostName,
} from './config.js';

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
    message: `Config found at ${path} (use --reuse-token to keep existing token)`,
  };
}

/**
 * Check token security — warn that pair logs print tokens to console.
 */
export async function checkTokenSecurity(): Promise<CheckResult> {
  const config = loadConfig();
  
  if (!config?.token) {
    return {
      name: 'Token security',
      status: 'pass',
      message: 'No token configured yet',
    };
  }

  // Warn that tokens are printed to console during pair
  return {
    name: 'Token security',
    status: 'warn',
    message: 'Pair logs print bearer token to console — avoid screen sharing during pair',
    fix: 'Use --reuse-token when config exists to avoid regenerating/re-printing token',
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
          message: `Codex binary not found: ${bin} (Wingman will run Claude-only; list_sessions degrades gracefully)`,
          fix: 'Install Codex CLI and ensure `codex` is on PATH, set CODEX_BIN=/path/to/codex, or set CODEX_MOCK=1',
        });
      } else {
        resolve({
          name: 'Codex binary',
          status: 'warn',
          message: `Codex error: ${err.message} (Wingman will run Claude-only)`,
          fix: 'Check Codex installation, set CODEX_BIN path, or set CODEX_MOCK=1',
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
          message: `Codex exited with code ${code} (Wingman will run Claude-only)`,
          fix: 'Codex may need authentication or setup',
        });
      }
    });
  });
}

export async function checkMuseBinary(): Promise<CheckResult> {
  if (process.env.MUSE_MOCK === '1' || process.env.MUSE_MOCK === 'true') {
    return {
      name: 'Muse binary',
      status: 'pass',
      message: 'MUSE_MOCK=1 (binary check skipped)',
    };
  }

  const bin = process.env.MUSE_BIN?.trim() || 'muse';

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
          name: 'Muse binary',
          status: 'warn',
          message: `Muse binary not found: ${bin} (optional — only needed for Muse provider)`,
          fix: 'Install Muse Code CLI and ensure `muse` is on PATH, or set MUSE_MOCK=1',
        });
      } else {
        resolve({
          name: 'Muse binary',
          status: 'warn',
          message: `Muse error: ${err.message} (optional — only needed for Muse provider)`,
          fix: 'Check Muse installation, or set MUSE_MOCK=1',
        });
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        const version = stdout.trim().split('\n')[0] || 'version unknown';
        resolve({
          name: 'Muse binary',
          status: 'pass',
          message: `Muse available: ${version}`,
        });
      } else {
        resolve({
          name: 'Muse binary',
          status: 'warn',
          message: `Muse exited with code ${code} (optional — only needed for Muse provider)`,
          fix: 'Muse may need authentication or setup',
        });
      }
    });
  });
}

/**
 * Check if the configured Codex model may require API access.
 * This is advisory only — Wingman does not recommend specific fallback models.
 * Users should use their session's model, Codex defaults, or explicit overrides.
 */
export async function checkCodexModel(): Promise<CheckResult> {
  if (process.env.CODEX_MOCK === '1' || process.env.CODEX_MOCK === 'true') {
    return {
      name: 'Codex model config',
      status: 'pass',
      message: 'CODEX_MOCK=1 (model check skipped)',
    };
  }

  // Check for WINGMAN_CODEX_MODEL env override first
  const envModel = resolveCodexModel();
  if (envModel) {
    if (isCodexModelApiOnly(envModel)) {
      return {
        name: 'Codex model config',
        status: 'warn',
        message: `WINGMAN_CODEX_MODEL="${envModel}" may require API access`,
        fix: `If you have API access, this model should work. For ChatGPT-only accounts, ` +
          `use a model your plan supports, or unset the override to let Codex pick its default.`,
      };
    }
    return {
      name: 'Codex model config',
      status: 'pass',
      message: `WINGMAN_CODEX_MODEL="${envModel}" (override active)`,
    };
  }

  // Check ~/.codex/config.toml for model setting
  const codexConfigPath = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(codexConfigPath)) {
    return {
      name: 'Codex model config',
      status: 'pass',
      message: 'No ~/.codex/config.toml found (Codex will use defaults)',
    };
  }

  try {
    const content = readFileSync(codexConfigPath, 'utf8');
    // Simple TOML parsing for model line - look for model = "..."
    const modelMatch = content.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    if (modelMatch) {
      const configModel = modelMatch[1];
      if (isCodexModelApiOnly(configModel)) {
        return {
          name: 'Codex model config',
          status: 'warn',
          message: `~/.codex/config.toml has model="${configModel}" (may require API access)`,
          fix: `If you have API access, keep this model. For ChatGPT-only accounts: ` +
            `use a model your plan supports, or unset \`model\` in config to let Codex pick its default. ` +
            `Override for Wingman only via WINGMAN_CODEX_MODEL or create_session.model.`,
        };
      }
      return {
        name: 'Codex model config',
        status: 'pass',
        message: `~/.codex/config.toml has model="${configModel}"`,
      };
    }
    return {
      name: 'Codex model config',
      status: 'pass',
      message: 'No explicit model in ~/.codex/config.toml (Codex will use defaults)',
    };
  } catch {
    return {
      name: 'Codex model config',
      status: 'pass',
      message: 'Could not read ~/.codex/config.toml (Codex will use defaults)',
    };
  }
}

/**
 * Check host identity configuration for multi-host setups.
 */
export async function checkHostIdentity(): Promise<CheckResult> {
  const hostId = resolveHostId();
  const hostName = resolveHostName();
  
  const hasEnvId = !!process.env.WINGMAN_HOST_ID?.trim();
  const hasEnvName = !!process.env.WINGMAN_HOST_NAME?.trim();
  
  if (hasEnvId || hasEnvName) {
    return {
      name: 'Host identity',
      status: 'pass',
      message: `hostId="${hostId}", hostName="${hostName}" (from env)`,
    };
  }
  
  return {
    name: 'Host identity',
    status: 'pass',
    message: `hostId="${hostId}", hostName="${hostName}" (from hostname — set WINGMAN_HOST_ID/NAME for multi-host)`,
  };
}

export async function runAllChecks(): Promise<CheckResult[]> {
  const checks = await Promise.all([
    checkNodeVersion(),
    checkConfig(),
    checkTokenSecurity(),
    checkPort(),
    checkClaudeSdk(),
    checkCodexBinary(),
    checkMuseBinary(),
    checkCodexModel(),
    checkHostIdentity(),
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

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                         Wingman Doctor                               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

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
