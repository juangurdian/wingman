#!/usr/bin/env node
/**
 * wingman-live-setup: Print setup steps for live session message injection
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CheckResult {
  name: string;
  status: 'ok' | 'missing' | 'error';
  message: string;
  setupSteps?: string[];
}

function checkClaudeCode(): CheckResult {
  try {
    const version = execSync('claude --version 2>/dev/null', { encoding: 'utf8' }).trim();
    return {
      name: 'Claude Code',
      status: 'ok',
      message: `Installed: ${version}`,
      setupSteps: [
        '# Claude Code background sessions:',
        '# 1. Start a background session:',
        '   claude --bg "Your task here"',
        '   # This prints a session ID like "abc123"',
        '',
        '# 2. Attach to it in your terminal:',
        '   claude attach abc123',
        '   # Now you see the chat live',
        '',
        '# 3. List running sessions:',
        '   claude agents --json',
        '',
        '# LIMITATION: Wingman cannot inject messages into an attached',
        '# session. Messages sent via Wingman go to a separate process.',
        '# The attached terminal will NOT show Wingman-sent messages.',
      ],
    };
  } catch {
    return {
      name: 'Claude Code',
      status: 'missing',
      message: 'Not installed or not in PATH',
      setupSteps: [
        '# Install Claude Code:',
        '   npm install -g @anthropic-ai/claude-code',
        '   # or',
        '   brew install claude-code',
      ],
    };
  }
}

function checkCodexCli(): CheckResult {
  try {
    const version = execSync('codex --version 2>/dev/null', { encoding: 'utf8' }).trim();
    return {
      name: 'Codex CLI',
      status: 'ok',
      message: `Installed: ${version}`,
    };
  } catch {
    return {
      name: 'Codex CLI',
      status: 'missing',
      message: 'Not installed or not in PATH',
      setupSteps: [
        '# Install Codex CLI:',
        '   curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      ],
    };
  }
}

function checkCodexDaemon(): CheckResult {
  const socketPath = join(
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control',
    'app-server-control.sock'
  );

  if (existsSync(socketPath)) {
    return {
      name: 'Codex Daemon',
      status: 'ok',
      message: `Running (socket: ${socketPath})`,
      setupSteps: [
        '# Codex daemon is running! Live injection is possible.',
        '',
        '# To use Wingman with the daemon:',
        '   export WINGMAN_CODEX_SOCKET=auto',
        '   npm run pair',
        '',
        '# In another terminal, start the Codex TUI:',
        '   codex',
        '   # The TUI auto-connects to the daemon',
        '',
        '# Now when Wingman sends a message via send_message,',
        '# it appears LIVE in the TUI!',
      ],
    };
  } else {
    return {
      name: 'Codex Daemon',
      status: 'missing',
      message: 'Not running (no control socket)',
      setupSteps: [
        '# Start the Codex daemon:',
        '   codex app-server daemon start',
        '',
        '# Verify it started:',
        '   codex app-server daemon version',
        '',
        '# The daemon creates a control socket at:',
        `   ${socketPath}`,
        '',
        '# Now start the Codex TUI (auto-connects to daemon):',
        '   codex',
        '',
        '# And start Wingman in attach mode:',
        '   export WINGMAN_CODEX_SOCKET=auto',
        '   npm run pair',
      ],
    };
  }
}

function checkChatGptApp(): CheckResult {
  const macAppPath = '/Applications/ChatGPT.app';
  if (process.platform === 'darwin' && existsSync(macAppPath)) {
    return {
      name: 'ChatGPT Desktop App',
      status: 'ok',
      message: 'Installed',
      setupSteps: [
        '# WARNING: The ChatGPT desktop app does NOT use daemon mode.',
        '# It spawns its own stdio-based app-servers that Wingman cannot attach to.',
        '',
        '# To enable live injection with the ChatGPT app:',
        '# 1. Close the ChatGPT desktop app',
        '# 2. Start the daemon manually:',
        '      codex app-server daemon start',
        '# 3. Use the Codex TUI instead of the ChatGPT app:',
        '      codex',
        '',
        '# The ChatGPT app and daemon cannot share sessions.',
      ],
    };
  }
  return {
    name: 'ChatGPT Desktop App',
    status: 'missing',
    message: 'Not detected',
  };
}

function printSection(title: string, content: string[]): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
  for (const line of content) {
    console.log(line);
  }
}

function main(): void {
  console.log('\n  Wingman Live Session Setup\n');
  console.log('This tool checks your environment for live session message injection.\n');

  const checks = [
    checkClaudeCode(),
    checkCodexCli(),
    checkCodexDaemon(),
    checkChatGptApp(),
  ];

  // Print status summary
  console.log('Status:');
  for (const check of checks) {
    const icon = check.status === 'ok' ? '✓' : check.status === 'missing' ? '✗' : '!';
    const color = check.status === 'ok' ? '\x1b[32m' : check.status === 'missing' ? '\x1b[31m' : '\x1b[33m';
    console.log(`  ${color}${icon}\x1b[0m ${check.name}: ${check.message}`);
  }

  // Print setup steps for items that need attention
  const needsSetup = checks.filter(c => c.setupSteps && c.setupSteps.length > 0);
  
  if (needsSetup.length > 0) {
    for (const check of needsSetup) {
      printSection(check.name, check.setupSteps!);
    }
  }

  // Print recommended workflow
  printSection('Recommended Workflow for Live Message Injection', [
    '',
    'Option 1: Codex TUI with Daemon (RECOMMENDED for live injection)',
    '-----------------------------------------------------------',
    '  Terminal 1: codex app-server daemon start',
    '  Terminal 2: codex  # TUI auto-connects to daemon',
    '  Terminal 3: WINGMAN_CODEX_SOCKET=auto npm run pair',
    '',
    '  Messages from Wingman appear LIVE in the TUI!',
    '',
    'Option 2: Claude Code Background Sessions',
    '-----------------------------------------',
    '  Terminal 1: claude --bg "Your task"  # Returns session ID',
    '  Terminal 2: claude attach <id>  # Watch the session',
    '  Terminal 3: npm run pair  # Use Wingman',
    '',
    '  NOTE: Messages from Wingman do NOT appear in attached terminal.',
    '  Wingman sends to a separate process. Use read_transcript to see results.',
    '',
  ]);

  // Exit with error if critical components missing
  const codexDaemon = checks.find(c => c.name === 'Codex Daemon');
  if (codexDaemon?.status === 'missing') {
    console.log('\nTo enable live injection, start the Codex daemon:\n');
    console.log('  codex app-server daemon start\n');
    process.exit(1);
  }
}

main();
