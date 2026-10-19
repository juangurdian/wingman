/**
 * Claude Code Cross-Session Inbox
 *
 * Send messages to running interactive Claude Code sessions via their per-session
 * Unix domain sockets (macOS/Linux) or named pipes (Windows).
 *
 * Docs:
 * - https://code.claude.com/docs/en/cross-session-messaging.md
 * - https://code.claude.com/docs/en/agent-view.md
 *
 * Discovery:
 * - `claude agents --json` lists live sessions (pid, sessionId, name, status/state, waitingFor)
 * - Registry files: ~/.claude/sessions/<pid>.json
 * - Socket/pipe path in registry field: messagingSocketPath
 *   - Unix: /tmp/cc-socks-<uid>/<pid>.sock or similar
 *   - Windows: \\.\pipe\LOCAL\cc-msg-<32 hex>
 *
 * Auth (from live testing on Windows):
 * - Key file: ~/.claude/sessions/<pid>.<sha256hex>.key
 * - Contains JSON: {peerToken (32 chars), procStartFt, pidDomain}
 * - Auth is REQUIRED on Windows: without it, pipe closes (EOF); wrong token breaks pipe
 * - Try auth on all platforms when key file exists
 * - Prefer CLAUDE_CODE_MESSAGING_TOKEN env var if set
 *
 * Wire format (newline-delimited JSON):
 * 1. Auth: {"type":"auth","token":"<32-char peerToken>"}
 * 2. Message: {"type":"user","message":{"role":"user","content":"<text>"}}
 *
 * Delivery:
 * - Server sends NO acknowledgement on success
 * - EOF or EPIPE within ~500ms after auth = rejection (bad token or no auth when required)
 * - 'delivered' means 'written without error'
 * - Idle session: starts a new turn immediately
 * - Mid-turn (busy): delivered between tool calls, folded into response
 * - UTF-8 text including accents, CJK, emoji (surrogate pairs) works
 *
 * Cost note: Each injected message is a full turn on that session's context.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, basename } from 'node:path';
import { createConnection, type Socket } from 'node:net';

/**
 * Check if a process with the given PID is currently running.
 * Cross-platform: uses process.kill(pid, 0) which works on POSIX and Windows.
 * Handles EPERM as alive (process exists but we don't have permission to signal it).
 */
export function isPidRunning(pid: number): boolean {
  if (!pid || pid <= 0 || !Number.isFinite(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means process exists but we don't have permission to signal it
    if (code === 'EPERM') return true;
    // ESRCH or anything else means no such process
    return false;
  }
}

export interface ClaudeLiveSession {
  sessionId: string;
  pid?: number;
  name?: string;
  status?: string;
  /** For background sessions that use 'state' instead of 'status' */
  state?: string;
  waitingFor?: string;
  /** From `claude agents --json` */
  agentId?: string;
  /** From registry file - Unix socket or Windows named pipe path */
  messagingSocketPath?: string;
  /** Whether the socket/pipe exists and is accessible */
  socketExists?: boolean;
  /** From registry: kind (interactive, background, etc.) */
  kind?: string;
  /** From registry: entrypoint */
  entrypoint?: string;
  /** From registry: cwd */
  cwd?: string;
  /** From registry: version */
  version?: string;
  /** From registry: pidDomain (e.g., "win32:pearlwolf") */
  pidDomain?: string;
  /** From registry: updatedAt timestamp */
  updatedAt?: number;
  /** Source of discovery */
  source: 'agents' | 'registry' | 'both';
  /** 
   * Whether this session is live (pid is running and registry file exists).
   * Live sessions can receive messages via inbox injection.
   * Past sessions have stale registry files (pid no longer running).
   */
  live?: boolean;
}

export interface SendToClaudeResult {
  sessionId: string;
  delivered: boolean;
  /** Socket/pipe path used (or attempted) */
  socketPath?: string;
  /** Warning messages */
  warning?: string;
  /** Error message if not delivered */
  error?: string;
  /** Whether the session was live (inbox injection) or past (would need SDK resume) */
  live?: boolean;
  /** 
   * Delivery method used:
   * - 'inbox': Live session, message sent via cross-session inbox socket
   * - 'past_session': Target is a past session, cannot deliver via inbox
   */
  method?: 'inbox' | 'past_session';
}

export interface ClaudeAgentsEntry {
  id?: string;
  sessionId?: string;
  pid?: number;
  name?: string;
  status?: string;
  /** Background sessions may use 'state' instead of 'status' */
  state?: string;
  waitingFor?: string;
}

export interface ClaudeRegistryEntry {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  procStart?: number;
  version?: string;
  peerProtocol?: number;
  peerFeatures?: string[];
  kind?: string;
  entrypoint?: string;
  pidDomain?: string;
  messagingSocketPath?: string;
  name?: string;
  nameSource?: string;
  nameSince?: number;
  status?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

export interface ClaudeKeyFileEntry {
  peerToken?: string;
  procStartFt?: number;
  pidDomain?: string;
}

/**
 * Registry entry with liveness information.
 */
export interface ClaudeRegistryWithLiveness extends ClaudeRegistryEntry {
  /** Whether the pid from this registry file is currently running */
  pidRunning: boolean;
  /** Source file path */
  registryPath?: string;
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
 * Check if a path looks like a Windows named pipe.
 * Windows pipes: \\.\pipe\... or \\?\pipe\...
 */
export function isWindowsNamedPipe(path: string): boolean {
  if (!path) return false;
  // Normalize: Node.js on Windows may use forward slashes
  const normalized = path.replace(/\//g, '\\');
  return normalized.startsWith('\\\\.\\pipe\\') || normalized.startsWith('\\\\?\\pipe\\');
}

/**
 * Parse `claude agents --json` output.
 * Background sessions may have no pid and use 'state' instead of 'status'.
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
        state: entry.state,
        waitingFor: entry.waitingFor,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Parse a single registry file from ~/.claude/sessions/<pid>.json
 */
export function parseRegistryFile(content: string): ClaudeRegistryEntry | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      startedAt: parsed.startedAt,
      procStart: parsed.procStart,
      version: parsed.version,
      peerProtocol: parsed.peerProtocol,
      peerFeatures: Array.isArray(parsed.peerFeatures) ? parsed.peerFeatures : undefined,
      kind: parsed.kind,
      entrypoint: parsed.entrypoint,
      pidDomain: parsed.pidDomain,
      messagingSocketPath: parsed.messagingSocketPath,
      name: parsed.name,
      nameSource: parsed.nameSource,
      nameSince: parsed.nameSince,
      status: parsed.status,
      updatedAt: parsed.updatedAt,
      statusUpdatedAt: parsed.statusUpdatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a key file from ~/.claude/sessions/<pid>.<sha256hex>.key
 */
export function parseKeyFile(content: string): ClaudeKeyFileEntry | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return {
      peerToken: typeof parsed.peerToken === 'string' ? parsed.peerToken : undefined,
      procStartFt: parsed.procStartFt,
      pidDomain: parsed.pidDomain,
    };
  } catch {
    return null;
  }
}

/**
 * Find the auth token for a session by pid.
 * Looks for ~/.claude/sessions/<pid>.<hash>.key files.
 * Returns the peerToken if found, or CLAUDE_CODE_MESSAGING_TOKEN env var.
 */
export function findAuthToken(pid: number | undefined): string | undefined {
  // Prefer environment variable if set
  const envToken = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (envToken) return envToken;

  if (!pid) return undefined;

  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return undefined;

  try {
    const files = readdirSync(sessionsDir);
    // Look for <pid>.<hash>.key files
    const keyFilePattern = new RegExp(`^${pid}\\.[a-f0-9]+\\.key$`, 'i');
    const keyFile = files.find((f) => keyFilePattern.test(f));

    if (keyFile) {
      const keyPath = join(sessionsDir, keyFile);
      const content = readFileSync(keyPath, 'utf8');
      const keyEntry = parseKeyFile(content);
      if (keyEntry?.peerToken) {
        return keyEntry.peerToken;
      }
    }
  } catch {
    // Ignore errors reading key files
  }

  return undefined;
}

/**
 * Scan registry directory for session files.
 * Registry files are named <pid>.json
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
      // Only process <pid>.json files (not .key files)
      if (!file.endsWith('.json')) continue;
      // Skip files that don't look like <number>.json
      const pidMatch = file.match(/^(\d+)\.json$/);
      if (!pidMatch) continue;

      const filePath = join(sessionsDir, file);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;

        const content = readFileSync(filePath, 'utf8');
        const entry = parseRegistryFile(content);
        if (entry) {
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
 * Scan registry directory for session files with liveness information.
 * Registry files are named <pid>.json. A session is "live" if the pid is running.
 */
export function scanRegistryFilesWithLiveness(): Map<string, ClaudeRegistryWithLiveness> {
  const result = new Map<string, ClaudeRegistryWithLiveness>();
  const sessionsDir = getSessionsDir();

  if (!existsSync(sessionsDir)) {
    return result;
  }

  try {
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      // Only process <pid>.json files (not .key files)
      if (!file.endsWith('.json')) continue;
      // Skip files that don't look like <number>.json
      const pidMatch = file.match(/^(\d+)\.json$/);
      if (!pidMatch) continue;

      const filePath = join(sessionsDir, file);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;

        const content = readFileSync(filePath, 'utf8');
        const entry = parseRegistryFile(content);
        if (entry) {
          const pid = entry.pid ?? parseInt(pidMatch[1], 10);
          const pidRunning = isPidRunning(pid);
          const key = entry.sessionId ?? pid.toString();
          
          result.set(key, {
            ...entry,
            pid,
            pidRunning,
            registryPath: filePath,
          });
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
 * Check if a socket/pipe path exists and is accessible.
 * For Unix sockets, check if it's a socket file.
 * For Windows named pipes, we can't easily check existence without connecting.
 */
function socketPathExists(socketPath: string): boolean {
  if (!socketPath) return false;

  // Windows named pipes can't be stat'd - assume they exist if the path looks valid
  if (isWindowsNamedPipe(socketPath)) {
    return true; // Will fail on connect if not actually present
  }

  // Unix socket - check if file exists
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
 * List all Claude Code sessions with liveness and inbox socket status.
 * 
 * A session is LIVE only when it has a registry entry (~/.claude/sessions/<pid>.json)
 * with a running pid. Sessions from `claude agents` that don't have a registry entry
 * (e.g., blocked background jobs) are PAST, not live.
 * 
 * Past sessions have stale registry files with dead pids, or exist only as
 * jobs/transcripts without a running process.
 */
export async function listClaudeLiveSessions(): Promise<ClaudeLiveSession[]> {
  if (useMock()) {
    return getMockLiveSessions();
  }

  const sessions = new Map<string, ClaudeLiveSession>();

  // 1. Scan registry files first to get authoritative liveness info
  // A session is live ONLY if its registry entry has a running pid
  const registry = scanRegistryFilesWithLiveness();
  const liveBySessionId = new Map<string, ClaudeRegistryWithLiveness>();
  const liveByPid = new Map<number, ClaudeRegistryWithLiveness>();
  
  for (const [key, entry] of registry) {
    if (entry.sessionId) liveBySessionId.set(entry.sessionId, entry);
    if (entry.pid) liveByPid.set(entry.pid, entry);
    
    // Add registry entries as sessions
    sessions.set(key, {
      sessionId: entry.sessionId ?? key,
      pid: entry.pid,
      name: entry.name,
      status: entry.status,
      messagingSocketPath: entry.messagingSocketPath,
      kind: entry.kind,
      entrypoint: entry.entrypoint,
      cwd: entry.cwd,
      version: entry.version,
      pidDomain: entry.pidDomain,
      updatedAt: entry.updatedAt,
      source: 'registry',
      live: entry.pidRunning, // Live ONLY if pid is running
    });
  }

  // 2. Get sessions from `claude agents --json` and merge
  // Note: `claude agents` lists both running sessions AND blocked/stopped background jobs
  // We do NOT assume these are live - liveness is determined by registry pid check
  const agents = runClaudeAgents();
  for (const agent of agents) {
    const key = agent.sessionId ?? agent.id ?? agent.pid?.toString();
    if (!key) continue;

    // Check if this session has a registry entry with running pid
    const registryEntry = liveBySessionId.get(key) ?? 
      (agent.pid ? liveByPid.get(agent.pid) : undefined);
    const isLive = registryEntry?.pidRunning ?? false;
    
    const existing = sessions.get(key) ??
      (agent.pid ? sessions.get(agent.pid.toString()) : undefined);

    if (existing) {
      // Merge agents info into existing session from registry
      if (!existing.name && agent.name) existing.name = agent.name;
      if (!existing.status && agent.status) existing.status = agent.status;
      if (!existing.state && agent.state) existing.state = agent.state;
      existing.waitingFor = agent.waitingFor;
      existing.agentId = agent.id;
      existing.source = 'both';
      // Do NOT override live - registry's pidRunning is authoritative
    } else {
      // Session from agents only, no registry entry = NOT live
      // This happens for blocked/stopped background jobs
      sessions.set(key, {
        sessionId: key,
        pid: agent.pid,
        name: agent.name,
        status: agent.status,
        state: agent.state,
        waitingFor: agent.waitingFor,
        agentId: agent.id,
        source: 'agents',
        live: isLive, // false unless we found a registry entry with running pid
      });
    }
  }

  // 3. Check socket existence for each session
  for (const session of sessions.values()) {
    if (session.messagingSocketPath) {
      session.socketExists = socketPathExists(session.messagingSocketPath);
    }
  }

  return Array.from(sessions.values());
}

export interface ResolveSessionResult {
  session: ClaudeLiveSession | null;
  error?: string;
  matches?: ClaudeLiveSession[];
  /** Whether the resolved session is a past session (not live) */
  resolvedToPast?: boolean;
}

/**
 * Find a session by target (sessionId, name, or pid).
 * 
 * Resolution priority:
 * 1. Exact sessionId match (live preferred)
 * 2. Exact agentId match
 * 3. Exact pid match
 * 4. Name substring match with live session preference:
 *    - If exactly one live session matches, use it (even if past sessions share the name)
 *    - If multiple live sessions match, return ambiguity error
 *    - If no live sessions match, fall back to past sessions
 */
export async function resolveSessionTarget(
  target: string,
): Promise<ResolveSessionResult> {
  const sessions = await listClaudeLiveSessions();

  // Try exact sessionId match - prefer live session if multiple have same id (unlikely)
  const byIdMatches = sessions.filter((s) => s.sessionId === target);
  if (byIdMatches.length > 0) {
    const liveMatch = byIdMatches.find((s) => s.live);
    if (liveMatch) return { session: liveMatch };
    return { session: byIdMatches[0], resolvedToPast: !byIdMatches[0].live };
  }

  // Try exact agentId match
  const byAgentId = sessions.find((s) => s.agentId === target);
  if (byAgentId) return { session: byAgentId, resolvedToPast: !byAgentId.live };

  // Try pid match
  const pid = parseInt(target, 10);
  if (!isNaN(pid)) {
    const byPid = sessions.find((s) => s.pid === pid);
    if (byPid) return { session: byPid, resolvedToPast: !byPid.live };
  }

  // Try name match (case-insensitive substring) with live preference
  const byName = sessions.filter(
    (s) => s.name && s.name.toLowerCase().includes(target.toLowerCase()),
  );
  
  if (byName.length === 0) {
    return { session: null, error: `No session found matching "${target}"` };
  }
  
  // Separate live and past matches
  const liveMatches = byName.filter((s) => s.live);
  const pastMatches = byName.filter((s) => !s.live);
  
  // If exactly one live session matches, use it
  if (liveMatches.length === 1) {
    return { session: liveMatches[0] };
  }
  
  // If multiple live sessions match, return ambiguity error (only list live ones)
  if (liveMatches.length > 1) {
    return {
      session: null,
      error: `Ambiguous target "${target}" matches ${liveMatches.length} live sessions`,
      matches: liveMatches,
    };
  }
  
  // No live matches - fall back to past sessions
  if (pastMatches.length === 1) {
    return { session: pastMatches[0], resolvedToPast: true };
  }
  
  if (pastMatches.length > 1) {
    return {
      session: null,
      error: `Ambiguous target "${target}" matches ${pastMatches.length} past sessions (no live matches)`,
      matches: pastMatches,
      resolvedToPast: true,
    };
  }

  return { session: null, error: `No session found matching "${target}"` };
}

/**
 * Send a message to a Claude Code session via its inbox socket/pipe.
 * 
 * For live sessions (pid running): uses cross-session inbox socket injection.
 * For past sessions (pid not running): returns error indicating SDK resume is needed.
 */
export async function sendToClaudeSession(
  target: string,
  text: string,
): Promise<SendToClaudeResult> {
  if (useMock()) {
    return mockSendToSession(target, text);
  }

  // Resolve target with live preference
  const { session, error, matches, resolvedToPast } = await resolveSessionTarget(target);

  if (!session) {
    if (matches && matches.length > 0) {
      const matchList = matches
        .map((m) => `  - sessionId: ${m.sessionId}, name: ${m.name ?? '(unnamed)'}, pid: ${m.pid ?? '?'}, live: ${m.live ?? false}`)
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

  // If resolved to a past session, can't use inbox - need SDK resume
  if (!session.live || resolvedToPast) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      live: false,
      method: 'past_session',
      error: `Session "${session.sessionId}" is a past session (pid ${session.pid ?? 'unknown'} not running). ` +
        `Use send_message with provider='claude' to resume it via SDK. ` +
        `Note: Resuming a session also open interactively would fork it.`,
    };
  }

  // Check socket
  const socketPath = session.messagingSocketPath;
  if (!socketPath) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      live: true,
      error: `No messaging socket path found for session "${session.sessionId}". ` +
        `The session may not have cross-session messaging enabled, or the registry file is incomplete.`,
    };
  }

  // For Unix sockets, check existence. Named pipes are checked on connect.
  if (!isWindowsNamedPipe(socketPath) && !session.socketExists) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      socketPath,
      live: true,
      error: `Socket file does not exist: ${socketPath}. ` +
        `The session may have just exited or the socket was cleaned up.`,
    };
  }

  // Find auth token
  const authToken = findAuthToken(session.pid);

  // Connect and send
  try {
    await sendViaSocket(socketPath, text, authToken);
    return {
      sessionId: session.sessionId,
      delivered: true,
      socketPath,
      live: true,
      method: 'inbox',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Categorize error for better user feedback
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT') || msg.includes('timeout')) {
      return {
        sessionId: session.sessionId,
        delivered: false,
        socketPath,
        live: true,
        error: `Socket/pipe not reachable: ${msg}. The session may have exited.`,
      };
    }

    if (msg.includes('auth_rejected') || msg.includes('EPIPE') || msg.includes('EOF')) {
      return {
        sessionId: session.sessionId,
        delivered: false,
        socketPath,
        live: true,
        error: `Authentication rejected or connection closed. ` +
          (authToken ? 'Token may be invalid.' : 'No auth token found - auth may be required.'),
      };
    }

    return {
      sessionId: session.sessionId,
      delivered: false,
      socketPath,
      live: true,
      error: `Failed to send message: ${msg}`,
    };
  }
}

/**
 * Send a message via Unix socket or Windows named pipe.
 *
 * Protocol:
 * 1. Connect to socket/pipe
 * 2. Send auth line if token available (required on Windows)
 * 3. Send user message line
 * 4. Server sends NO acknowledgement on success
 * 5. EOF or EPIPE within ~500ms after auth = rejection
 * 6. 'delivered' = written without error
 */
async function sendViaSocket(
  socketPath: string,
  text: string,
  authToken: string | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Connection timeout: 3s for missing pipe/socket
    const connectTimeoutMs = 3000;
    // Rejection detection timeout: 500ms after sending
    const rejectionTimeoutMs = 500;

    let socket: Socket | null = null;
    let connected = false;
    let messageSent = false;
    let rejectionTimer: ReturnType<typeof setTimeout> | null = null;

    const connectTimer = setTimeout(() => {
      if (socket) socket.destroy();
      reject(new Error(`Connection timeout after ${connectTimeoutMs}ms - socket/pipe may not exist`));
    }, connectTimeoutMs);

    socket = createConnection(socketPath, () => {
      clearTimeout(connectTimer);
      connected = true;

      // Build messages
      const messages: string[] = [];

      // Auth line - send whenever we have a token (required on Windows, optional elsewhere)
      if (authToken) {
        messages.push(JSON.stringify({ type: 'auth', token: authToken }));
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
        if (err) {
          if (rejectionTimer) clearTimeout(rejectionTimer);
          reject(err);
          return;
        }

        messageSent = true;

        // Start rejection detection timer
        // If we get EOF/close within this window, it means rejection
        rejectionTimer = setTimeout(() => {
          // No rejection detected, consider it delivered
          socket!.destroy();
          resolve();
        }, rejectionTimeoutMs);
      });
    });

    socket.on('error', (err) => {
      clearTimeout(connectTimer);
      if (rejectionTimer) clearTimeout(rejectionTimer);

      if (!connected) {
        reject(new Error(`Connection failed: ${err.message}`));
      } else if (messageSent) {
        // Error after sending = likely auth rejection (EPIPE)
        reject(new Error(`auth_rejected: ${err.message}`));
      } else {
        reject(err);
      }
    });

    socket.on('close', (hadError) => {
      clearTimeout(connectTimer);

      if (rejectionTimer) {
        clearTimeout(rejectionTimer);

        if (messageSent && !hadError) {
          // Closed cleanly right after sending = likely rejection (no ack expected)
          // But if we're within rejection window, treat as rejection
          reject(new Error('EOF: Connection closed immediately after sending - possible auth rejection'));
        } else if (messageSent) {
          // Closed with error after sending
          reject(new Error('auth_rejected: Connection closed with error'));
        }
      }
    });

    socket.on('end', () => {
      // Server closed its end - if this happens quickly, it's rejection
      if (rejectionTimer) {
        clearTimeout(rejectionTimer);
        reject(new Error('EOF: Server closed connection - possible auth rejection'));
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

// For testing: mock key file lookup
let mockAuthTokens: Map<number, string> = new Map();

export function setMockAuthToken(pid: number, token: string): void {
  mockAuthTokens.set(pid, token);
}

export function clearMockAuthTokens(): void {
  mockAuthTokens.clear();
}

async function mockSendToSession(target: string, text: string): Promise<SendToClaudeResult> {
  if (mockSendHandler) {
    return mockSendHandler(target, text);
  }

  const { session, error, matches, resolvedToPast } = await resolveSessionTarget(target);

  if (!session) {
    if (matches && matches.length > 0) {
      const matchList = matches
        .map((m) => `  - sessionId: ${m.sessionId}, name: ${m.name ?? '(unnamed)'}, pid: ${m.pid ?? '?'}, live: ${m.live ?? false}`)
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

  // Check if session is past (not live)
  if (!session.live || resolvedToPast) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      live: false,
      method: 'past_session',
      error: `Session "${session.sessionId}" is a past session (pid ${session.pid ?? 'unknown'} not running). ` +
        `Use send_message with provider='claude' to resume it via SDK. ` +
        `Note: Resuming a session also open interactively would fork it.`,
    };
  }

  if (!session.socketExists && !isWindowsNamedPipe(session.messagingSocketPath ?? '')) {
    return {
      sessionId: session.sessionId,
      delivered: false,
      socketPath: session.messagingSocketPath,
      live: true,
      error: 'Socket does not exist (mock)',
    };
  }

  return {
    sessionId: session.sessionId,
    delivered: true,
    socketPath: session.messagingSocketPath,
    live: true,
    method: 'inbox',
  };
}
