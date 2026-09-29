/**
 * Claude Code Cross-Session Inbox
 *
 * Send messages to running interactive Claude Code sessions via their per-session
 * Unix domain sockets (Windows: named pipes).
 *
 * Docs:
 * - https://code.claude.com/docs/en/cross-session-messaging.md
 * - https://code.claude.com/docs/en/agent-view.md
 *
 * Discovery:
 * - `claude agents --json` lists live sessions (pid, sessionId, name, status, waitingFor)
 * - Registry files in ~/.claude/sessions/ contain messagingSocketPath, pid, name, kind, jobId
 * - Socket path also in CLAUDE_CODE_MESSAGING_SOCKET env var (per-session)
 * - Fallback socket dir: /tmp/cc-socks-<uid>/
 *
 * Wire format (connect within 30s):
 * 1. Optional: {"type":"auth","token":"$CLAUDE_CODE_MESSAGING_TOKEN"} (required on Windows)
 * 2. Required: {"type":"user","message":{"role":"user","content":"<text>"}}
 *
 * Delivery:
 * - Idle session: starts a new turn
 * - Mid-turn: read between tool calls, shows as 'Message from ...'
 * - Bypass-permissions mode: may hold behind approval dialog (crossSessionInbound setting)
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { join, basename } from 'node:path';
import { createConnection, type Socket } from 'node:net';

export interface ClaudeLiveSession {
  sessionId: string;
  pid?: number;
  name?: string;
  status?: string;
  waitingFor?: string;
  /** From `claude agents --json` */
  agentId?: string;
  /** From registry file */
  messagingSocketPath?: string;
  /** Whether the socket file exists and is accessible */
  socketExists?: boolean;
  /** From registry: kind (interactive, background, print, etc.) */
  kind?: string;
  /** From registry: jobId */
  jobId?: string;
  /** Permission mode if discoverable (bypass-permissions, normal, etc.) */
  permissionMode?: string;
  /** Source of discovery */
  source: 'agents' | 'registry' | 'both';
}

export interface SendToClaudeResult {
  sessionId: string;
  delivered: boolean;
  /** Socket path used (or attempted) */
  socketPath?: string;
  /** Warning messages (e.g., bypass mode may hold message) */
  warning?: string;
  /** Error message if not delivered */
  error?: string;
}

export interface ClaudeAgentsEntry {
  id?: string;
  sessionId?: string;
  pid?: number;
  name?: string;
  status?: string;
  waitingFor?: string;
}

export interface ClaudeRegistryEntry {
  messagingSocketPath?: string;
  pid?: number;
  name?: string;
  kind?: string;
  jobId?: string;
  sessionId?: string;
  permissionMode?: string;
}

function useMock(): boolean {
  return process.env.CLAUDE_INBOX_MOCK === '1' || process.env.CLAUDE_INBOX_MOCK === 'true';
}

/**
 * Get the directory where Claude Code stores session registry files.
 */
function getSessionsDir(): string {
  return process.env.CLAUDE_SESSIONS_DIR ?? join(homedir(), '.claude', 'sessions');
}

/**
 * Get fallback socket directory (used on some systems).
 */
function getFallbackSocketDir(): string {
  try {
    const uid = userInfo().uid;
    return `/tmp/cc-socks-${uid}`;
  } catch {
    return '/tmp/cc-socks-0';
  }
}

/**
 * Parse `claude agents --json` output.
 */
export function parseClaudeAgentsOutput(output: string): ClaudeAgentsEntry[] {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId ?? entry.id,
        pid: typeof entry.pid === 'number' ? entry.pid : undefined,
        name: entry.name,
        status: entry.status,
        waitingFor: entry.waitingFor,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Parse a single registry file from ~/.claude/sessions/.
 */
export function parseRegistryFile(content: string): ClaudeRegistryEntry | null {
  try {
    const parsed = JSON.parse(content);
    // Must be a plain object, not array, null, or primitive
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return {
      messagingSocketPath: parsed.messagingSocketPath,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      name: parsed.name,
      kind: parsed.kind,
      jobId: parsed.jobId,
      sessionId: parsed.sessionId ?? parsed.id,
      permissionMode: parsed.permissionMode ?? parsed.crossSessionInbound,
    };
  } catch {
    return null;
  }
}

/**
 * Scan registry directory for session files.
 */
export function scanRegistryFiles(): Map<string, ClaudeRegistryEntry> {
  const result = new Map<string, ClaudeRegistryEntry>();
  const sessionsDir = getSessionsDir();

  if (!existsSync(sessionsDir)) {
    return result;
  }

  try {
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        // Only parse JSON files
        if (!file.endsWith('.json') && !file.includes('.')) continue;

        const content = readFileSync(filePath, 'utf8');
        const entry = parseRegistryFile(content);
        if (entry) {
          // Use sessionId, pid, or filename as key
          const key = entry.sessionId ?? entry.pid?.toString() ?? basename(file, '.json');
          result.set(key, entry);
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory not readable
  }

  return result;
}

/**
 * Check if a socket path exists.
 */
function socketPathExists(socketPath: string): boolean {
  if (!socketPath) return false;
  try {
    const stat = statSync(socketPath);
    return stat.isSocket?.() ?? existsSync(socketPath);
  } catch {
    return false;
  }
}

/**
 * Run `claude agents --json` and parse the output.
 */
export function runClaudeAgents(): ClaudeAgentsEntry[] {
  if (useMock()) {
    return [];
  }

  try {
    const result = spawnSync('claude', ['agents', '--json'], {
      encoding: 'utf8',
      timeout: 10000,
      shell: platform() === 'win32',
    });

    if (result.error || result.status !== 0) {
      return [];
    }

    return parseClaudeAgentsOutput(result.stdout);
  } catch {
    return [];
  }
}

/**
 * List all live Claude Code sessions with their inbox socket status.
 */
export async function listClaudeLiveSessions(): Promise<ClaudeLiveSession[]> {
  if (useMock()) {
    return getMockLiveSessions();
  }

  const sessions = new Map<string, ClaudeLiveSession>();

  // 1. Get sessions from `claude agents --json`
  const agents = runClaudeAgents();
  for (const agent of agents) {
    const key = agent.sessionId ?? agent.id ?? agent.pid?.toString();
    if (!key) continue;

    sessions.set(key, {
      sessionId: key,
      pid: agent.pid,
      name: agent.name,
      status: agent.status,
      waitingFor: agent.waitingFor,
      agentId: agent.id,
      source: 'agents',
    });
  }

  // 2. Merge with registry files
  const registry = scanRegistryFiles();
  for (const [key, entry] of registry) {
    const existing = sessions.get(key) ??
      (entry.pid ? sessions.get(entry.pid.toString()) : undefined) ??
      (entry.sessionId ? sessions.get(entry.sessionId) : undefined);

    if (existing) {
      // Merge registry info into existing session
      existing.messagingSocketPath = entry.messagingSocketPath;
      existing.kind = entry.kind;
      existing.jobId = entry.jobId;
      existing.permissionMode = entry.permissionMode;
      existing.source = 'both';
      if (!existing.name && entry.name) existing.name = entry.name;
      if (!existing.pid && entry.pid) existing.pid = entry.pid;
    } else {
      // New session from registry only
      sessions.set(key, {
        sessionId: entry.sessionId ?? key,
        pid: entry.pid,
        name: entry.name,
        messagingSocketPath: entry.messagingSocketPath,
        kind: entry.kind,
        jobId: entry.jobId,
        permissionMode: entry.permissionMode,
        source: 'registry',
      });
    }
  }

  // 3. Check socket existence for each session
  for (const session of sessions.values()) {
    if (session.messagingSocketPath) {
      session.socketExists = socketPathExists(session.messagingSocketPath);
    } else {
      // Try to find socket in fallback location
      const fallbackDir = getFallbackSocketDir();
      if (session.pid && existsSync(fallbackDir)) {
        const possibleSocket = join(fallbackDir, `${session.pid}.sock`);
        if (socketPathExists(possibleSocket)) {
          session.messagingSocketPath = possibleSocket;
          session.socketExists = true;
        }
      }
    }
  }

  return Array.from(sessions.values());
}

/**
 * Find a session by target (sessionId, name, or pid).
 * Returns error if ambiguous (multiple matches by name).
 */
export async function resolveSessionTarget(
  target: string,
): Promise<{ session: ClaudeLiveSession | null; error?: string; matches?: ClaudeLiveSession[] }> {
  const sessions = await listClaudeLiveSessions();

  // Try exact sessionId match
  const byId = sessions.find((s) => s.sessionId === target);
  if (byId) return { session: byId };

  // Try exact agentId match
  const byAgentId = sessions.find((s) => s.agentId === target);
  if (byAgentId) return { session: byAgentId };

  // Try pid match
  const pid = parseInt(target, 10);
  if (!isNaN(pid)) {
    const byPid = sessions.find((s) => s.pid === pid);
    if (byPid) return { session: byPid };
  }

  // Try name match (case-insensitive substring)
  const byName = sessions.filter(
    (s) => s.name && s.name.toLowerCase().includes(target.toLowerCase()),
  );
  if (byName.length === 1) return { session: byName[0] };
  if (byName.length > 1) {
    return {
      session: null,
      error: `Ambiguous target "${target}" matches ${byName.length} sessions`,
      matches: byName,
    };
  }

  return { session: null, error: `No session found matching "${target}"` };
}

/**
 * Send a message to a Claude Code session via its inbox socket.
 */
export async function sendToClaudeSession(
  target: string,
  text: string,
): Promise<SendToClaudeResult> {
  if (useMock()) {
    return mockSendToSession(target, text);
  }

  // Resolve target
  const { session, error, matches } = await resolveSessionTarget(target);

  if (!session) {
    if (matches && matches.length > 0) {
      const matchList = matches
        .map((m) => `  - sessionId: ${m.sessionId}, name: ${m.name ?? '(unnamed)'}, pid: ${m.pid ?? '?'}`)
        .join('\n');
      return {
        sessionId: target,
        delivered: false,
        error: `${error}:\n${matchList}`,
      };
    }
    return {
      sessionId: target,
      delivered: false,
      error: error ?? `No session found matching "${target}"`,
    };
  }

  // Check socket
  const socketPath = session.messagingSocketPath;
  if (!socketPath) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      error: `No messaging socket path found for session "${session.sessionId}". ` +
        `The session may not have cross-session messaging enabled, or the registry file is incomplete.`,
    };
  }

  if (!session.socketExists) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      socketPath,
      error: `Socket file does not exist: ${socketPath}. ` +
        `The session may have exited or the socket was cleaned up.`,
    };
  }

  // Prepare warning for bypass-permissions mode
  let warning: string | undefined;
  if (session.permissionMode === 'bypass-permissions' || session.kind === 'dangerous') {
    warning =
      'Session is in bypass-permissions mode. Message may be held behind an approval dialog ' +
      'unless crossSessionInbound=accept is configured.';
  }

  // Connect and send
  try {
    await sendViaSocket(socketPath, text);
    return {
      sessionId: session.sessionId,
      delivered: true,
      socketPath,
      warning,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      sessionId: session.sessionId,
      delivered: false,
      socketPath,
      error: `Failed to send message: ${msg}`,
    };
  }
}

/**
 * Send a message via Unix socket (or Windows named pipe).
 */
async function sendViaSocket(socketPath: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = 30000; // 30 second connection timeout per docs
    let socket: Socket | null = null;
    let connected = false;

    const timer = setTimeout(() => {
      if (socket) socket.destroy();
      reject(new Error(`Connection timeout after ${timeout}ms`));
    }, timeout);

    socket = createConnection(socketPath, () => {
      connected = true;

      // Prepare messages
      const authToken = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      const messages: string[] = [];

      // Auth line (optional on macOS/Linux, required on Windows)
      if (authToken || platform() === 'win32') {
        if (authToken) {
          messages.push(JSON.stringify({ type: 'auth', token: authToken }));
        } else if (platform() === 'win32') {
          // Windows requires auth but no token available - try without
        }
      }

      // User message line
      messages.push(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: text },
        }),
      );

      // Send all messages (newline-delimited)
      const payload = messages.join('\n') + '\n';

      socket!.write(payload, (err) => {
        clearTimeout(timer);
        socket!.end();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      if (!connected) {
        reject(new Error(`Connection failed: ${err.message}`));
      } else {
        reject(err);
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (connected) {
        resolve();
      }
    });
  });
}

// Mock implementation for testing

let mockSessions: ClaudeLiveSession[] = [];

export function setMockLiveSessions(sessions: ClaudeLiveSession[]): void {
  mockSessions = sessions;
}

function getMockLiveSessions(): ClaudeLiveSession[] {
  return mockSessions;
}

let mockSendHandler: ((target: string, text: string) => SendToClaudeResult) | null = null;

export function setMockSendHandler(
  handler: ((target: string, text: string) => SendToClaudeResult) | null,
): void {
  mockSendHandler = handler;
}

async function mockSendToSession(target: string, text: string): Promise<SendToClaudeResult> {
  if (mockSendHandler) {
    return mockSendHandler(target, text);
  }

  const { session, error, matches } = await resolveSessionTarget(target);

  if (!session) {
    if (matches && matches.length > 0) {
      const matchList = matches
        .map((m) => `  - sessionId: ${m.sessionId}, name: ${m.name ?? '(unnamed)'}, pid: ${m.pid ?? '?'}`)
        .join('\n');
      return {
        sessionId: target,
        delivered: false,
        error: `${error}:\n${matchList}`,
      };
    }
    return {
      sessionId: target,
      delivered: false,
      error: error ?? `No session found matching "${target}"`,
    };
  }

  if (!session.socketExists) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      socketPath: session.messagingSocketPath,
      error: 'Socket does not exist (mock)',
    };
  }

  return {
    sessionId: session.sessionId,
    delivered: true,
    socketPath: session.messagingSocketPath,
    warning: session.permissionMode === 'bypass-permissions'
      ? 'Session in bypass-permissions mode - message may be held'
      : undefined,
  };
}
