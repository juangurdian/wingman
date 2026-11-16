#!/usr/bin/env node
/**
 * Token commands. Output is masked unless --show-token is passed.
 * wingman-token rotate writes ~/.wingman/config.json and does not start the server.
 */

import { isCliMain } from './cli-entry.js';
import { loadConfig, maskToken, rotateStoredToken, formatRotationMessage, safeErrorText, weakTokenReason } from './config.js';

function showTokenFlag(argv: string[]): boolean {
  return argv.includes('--show-token');
}

function printHelp(): void {
  console.log(`Usage: wingman-token <rotate|status> [--show-token]

rotate    Write a new random bearer token to the config file and print the
          MCP connector update. A running server keeps the old token until restart.
status    Print the masked token, and warn when it looks like a test value.

--show-token   Print the full token. Use this once, while setting up a connector.
`);
}

function printStatus(showToken: boolean): void {
  const config = loadConfig();
  if (!config?.token) {
    console.log('No token in the config file. Run wingman-pair or wingman-token rotate.');
    return;
  }
  const display = showToken ? config.token : maskToken(config.token);
  const reason = weakTokenReason(config.token);
  const lines = [
    `Token: ${display}${showToken ? '' : ' (masked)'}`,
    reason
      ? `Warning: the current token ${reason}. Run wingman-token rotate before exposing the bridge.`
      : 'The current token does not match a known test prefix.',
  ];
  const text = lines.join('\n');
  if (!showToken && text.includes(config.token)) {
    throw new Error('Refusing to print a status line that contains the full token');
  }
  console.log(text);
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv.find((arg) => !arg.startsWith('-'));
  if (!cmd || cmd === '--help' || argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }
  const show = showTokenFlag(argv);
  if (cmd === 'status') {
    printStatus(show);
    return;
  }
  if (cmd === 'rotate') {
    const rotated = rotateStoredToken();
    console.log(
      formatRotationMessage({
        path: rotated.path,
        token: rotated.token,
        showToken: show,
        previousWasWeak: rotated.previousWasWeak,
        weakReason: rotated.weakReason,
      }),
    );
    return;
  }
  printHelp();
  process.exitCode = 1;
}

const isMain = isCliMain(process.argv[1], ['token', 'wingman-token']);

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(safeErrorText(err, [loadConfig()?.token, process.env.WINGMAN_TOKEN]));
    process.exit(1);
  }
}
