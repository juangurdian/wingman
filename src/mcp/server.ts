#!/usr/bin/env node
/**
 * Streamable HTTP MCP server with bearer auth.
 * Binds to 127.0.0.1 by default â€” expose via cloudflared/tailscale for Grok Bot.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import {
  createToolHandlers,
  ListSessionsSchema,
  ReadTranscriptSchema,
  SendMessageSchema,
  InterruptSchema,
  CreateSessionSchema,
  GetSessionSchema,
  WaitTurnSchema,
  SteerSchema,
  ListApprovalsSchema,
  ResolveApprovalSchema,
  SetSessionMetaSchema,
  ExportTranscriptSchema,
  ListClaudeLiveSessionsSchema,
  SendToClaudeSessionSchema,
} from './tools.js';
import { bearerAuth } from './auth.js';
import { createProviders } from '../providers/index.js';
import {
  loadConfig,
  resolveHost,
  resolvePort,
  resolveToken,
  mcpUrl,
  isHealthzAuthFree,
  type BridgeConfig,
} from '../config.js';

export interface StartServerOptions {
  host?: string;
  port?: number;
  token?: string;
  /** When true, do not call process exit handlers that keep pair alive differently */
  quiet?: boolean;
}

export async function startMcpServer(opts: StartServerOptions = {}): Promise<{
  host: string;
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}> {
  const existing = loadConfig();
  const host = opts.host ?? resolveHost();
  const port = opts.port ?? resolvePort(existing?.port);
  const token = opts.token ?? existing?.token;
  if (!token) {
    throw new Error(
      'No bearer token configured. Run `npm run pair` first, or pass token explicitly.',
    );
  }

  const providers = createProviders();
  const handlers = createToolHandlers(providers);

  // createMcpExpressApp's `host` only controls DNS-rebinding Host checks.
  // Keep listen() on loopback (`host` below), but pass 0.0.0.0 here so
  // Cloudflare/Tailscale tunnel Hostnames are accepted. Bearer auth is the gate.
  const app = createMcpExpressApp({ host: '0.0.0.0' });

  // Health endpoint - auth requirement is configurable via WINGMAN_HEALTHZ_AUTH_FREE
  // Default: requires auth. Set WINGMAN_HEALTHZ_AUTH_FREE=1 for monitors/tunnels that need auth-free access.
  const healthzAuthFree = isHealthzAuthFree();
  if (healthzAuthFree) {
    app.get('/healthz', (_req, res) => {
      res.status(200).json({ ok: true, service: 'wingman' });
    });
  } else {
    app.get('/healthz', bearerAuth(token), (_req, res) => {
      res.status(200).json({ ok: true, service: 'wingman' });
    });
  }

  app.use('/mcp', bearerAuth(token));

  const createServer = () => {
    const server = new McpServer({
      name: 'wingman',
      version: '0.1.0',
    });

    // Use .shape from zod schemas to ensure registered inputSchema matches handler schema
    // This prevents drift where the MCP SDK strips params not in the registered schema
    
    server.registerTool(
      'list_sessions',
      {
        description:
          'List coding-agent sessions. Optional provider filter: codex | claude | muse. ' +
          'Optional state filter: live (only active sessions with running pid), past (only past/resumable), ' +
          'or all (default, live sessions sorted first).',
        inputSchema: ListSessionsSchema.shape,
      },
      async (args) => handlers.list_sessions(ListSessionsSchema.parse(args)),
    );

    server.registerTool(
      'read_transcript',
      {
        description: 'Read recent transcript messages for a session.',
        inputSchema: ReadTranscriptSchema.shape,
      },
      async (args) => handlers.read_transcript(ReadTranscriptSchema.parse(args)),
    );

    server.registerTool(
      'send_message',
      {
        description:
          'Send a user message into an existing session. For live Claude sessions, uses inbox ' +
          'injection (appears in existing terminal without forking). For past Claude sessions, ' +
          'uses SDK resume (may fork if session is also open interactively).',
        inputSchema: SendMessageSchema.shape,
      },
      async (args) => handlers.send_message(SendMessageSchema.parse(args)),
    );

    server.registerTool(
      'interrupt',
      {
        description: 'Interrupt an in-flight turn/session.',
        inputSchema: InterruptSchema.shape,
      },
      async (args) => handlers.interrupt(InterruptSchema.parse(args)),
    );

    server.registerTool(
      'create_session',
      {
        description:
          'Create a new session (Codex: thread/start). Optional cwd, initial prompt, name, tags, ' +
          'and model override (Codex only).',
        inputSchema: CreateSessionSchema.shape,
      },
      async (args) => handlers.create_session(CreateSessionSchema.parse(args)),
    );

    server.registerTool(
      'get_session',
      {
        description:
          'Get detailed session info including status (idle/running), active turn ID, and timestamps.',
        inputSchema: GetSessionSchema.shape,
      },
      async (args) => handlers.get_session(GetSessionSchema.parse(args)),
    );

    server.registerTool(
      'wait_turn',
      {
        description:
          'Wait for an active turn to complete, fail, be interrupted, or timeout. ' +
          'Returns status and latest message snippet. Use instead of polling read_transcript.',
        inputSchema: WaitTurnSchema.shape,
      },
      async (args) => handlers.wait_turn(WaitTurnSchema.parse(args)),
    );

    server.registerTool(
      'steer',
      {
        description:
          'Add guidance to an in-flight Codex turn without starting a new turn. ' +
          'Use this to provide mid-turn input like follow-up instructions or clarifications.',
        inputSchema: SteerSchema.shape,
      },
      async (args) => handlers.steer(SteerSchema.parse(args)),
    );

    server.registerTool(
      'list_approvals',
      {
        description:
          'List pending approval requests for a Codex session. ' +
          'Approvals are required for sandbox commands, file changes, or network access.',
        inputSchema: ListApprovalsSchema.shape,
      },
      async (args) => handlers.list_approvals(ListApprovalsSchema.parse(args)),
    );

    server.registerTool(
      'resolve_approval',
      {
        description:
          'Resolve a pending Codex approval request. Decisions: accept, acceptForSession, decline, cancel.',
        inputSchema: ResolveApprovalSchema.shape,
      },
      async (args) => handlers.resolve_approval(ResolveApprovalSchema.parse(args)),
    );

    server.registerTool(
      'set_session_meta',
      {
        description:
          'Set session metadata (name, tags) for easier discovery. Works for Wingman-owned sessions.',
        inputSchema: SetSessionMetaSchema.shape,
      },
      async (args) => handlers.set_session_meta(SetSessionMetaSchema.parse(args)),
    );

    server.registerTool(
      'export_transcript',
      {
        description:
          'Export a session transcript as Markdown or JSON. Returns content inline and writes to ~/.wingman/exports/.',
        inputSchema: ExportTranscriptSchema.shape,
      },
      async (args) => handlers.export_transcript(ExportTranscriptSchema.parse(args)),
    );

    server.registerTool(
      'list_claude_live_sessions',
      {
        description:
          'List running interactive Claude Code sessions with their inbox socket status. ' +
          'Returns sessionId, name, pid, status, whether an inbox socket was found, and permission mode. ' +
          'Use to discover targets for send_to_claude_session.',
        inputSchema: ListClaudeLiveSessionsSchema.shape,
      },
      async (args) => handlers.list_claude_live_sessions(ListClaudeLiveSessionsSchema.parse(args)),
    );

    server.registerTool(
      'send_to_claude_session',
      {
        description:
          'Send a message to a running interactive Claude Code session via its inbox socket. ' +
          'The message appears LIVE in the session as "Message from ...". ' +
          'Target can be sessionId, name (must be unambiguous), or pid. ' +
          'Idle sessions start a new turn; mid-turn messages are read between tool calls. ' +
          'Sessions in bypass-permissions mode may hold the message behind an approval dialog.',
        inputSchema: SendToClaudeSessionSchema.shape,
      },
      async (args) => handlers.send_to_claude_session(SendToClaudeSessionSchema.parse(args)),
    );

    return server;
  };

  // Stateless streamable HTTP (one transport+server per request) â€” simple & robust for tunnels.
  app.post('/mcp', async (req, res) => {
    const server = createServer();
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      console.error('MCP request error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    );
  });

  app.delete('/mcp', (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    );
  });

  const url = mcpUrl(host, port, '/mcp');

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve());
    httpServer.on('error', reject);
    (app as unknown as { __httpServer?: typeof httpServer }).__httpServer = httpServer;
  });

  if (!opts.quiet) {
    console.error(`wingman MCP listening on ${url}`);
    console.error(`mock=${process.env.CODEX_MOCK === '1' ? 'yes' : 'no'}`);
    console.error(`healthz_auth_free=${healthzAuthFree ? 'yes' : 'no'}`);
  }

  return {
    host,
    port,
    token,
    url,
    close: async () => {
      const httpServer = (app as unknown as { __httpServer?: { close: (cb: (err?: Error) => void) => void } })
        .__httpServer;
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
      for (const p of providers.all()) {
        const maybe = p as { close?: () => Promise<void> };
        if (maybe.close) await maybe.close();
      }
    },
  };
}

// CLI entry: `npm run dev` / node dist/mcp/server.js
const isMain =
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js') ||
  process.argv[1]?.includes('/mcp/server');

if (isMain) {
  const cfg: BridgeConfig | null = loadConfig();
  startMcpServer({
    token: resolveToken() || cfg?.token,
    port: resolvePort(cfg?.port),
    host: resolveHost(),
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// silence unused import in some bundlers
