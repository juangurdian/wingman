import { z } from 'zod';
import type { ProviderRegistry, ProviderName } from '../providers/index.js';

export const ProviderSchema = z.enum(['codex', 'claude']);

export const ListSessionsSchema = z.object({
  provider: ProviderSchema.optional(),
});

export const ReadTranscriptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
});

export const SendMessageSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
  text: z.string().min(1),
});

export const InterruptSchema = z.object({
  provider: ProviderSchema,
  session_id: z.string().min(1),
});

export const CreateSessionSchema = z.object({
  provider: ProviderSchema,
  cwd: z.string().optional(),
  prompt: z.string().optional(),
});

function textResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
  };
}

export function createToolHandlers(providers: ProviderRegistry) {
  return {
    async list_sessions(args: z.infer<typeof ListSessionsSchema>) {
      try {
        const names: ProviderName[] = args.provider
          ? [args.provider]
          : ['codex', 'claude'];
        const sessions = [];
        for (const name of names) {
          try {
            const list = await providers.get(name).listSessions();
            sessions.push(...list);
          } catch (err) {
            if (name === 'claude') {
              sessions.push({
                id: '_claude_stub',
                provider: 'claude' as const,
                preview: err instanceof Error ? err.message : String(err),
                status: 'not_enabled',
              });
            } else {
              throw err;
            }
          }
        }
        return textResult({ sessions });
      } catch (err) {
        return errorResult(err);
      }
    },

    async read_transcript(args: z.infer<typeof ReadTranscriptSchema>) {
      try {
        const transcript = await providers
          .get(args.provider)
          .readTranscript(args.session_id, args.limit);
        return textResult(transcript);
      } catch (err) {
        return errorResult(err);
      }
    },

    async send_message(args: z.infer<typeof SendMessageSchema>) {
      try {
        const result = await providers
          .get(args.provider)
          .sendMessage(args.session_id, args.text);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async interrupt(args: z.infer<typeof InterruptSchema>) {
      try {
        const result = await providers.get(args.provider).interrupt(args.session_id);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    async create_session(args: z.infer<typeof CreateSessionSchema>) {
      try {
        const provider = providers.get(args.provider);
        if (!provider.createSession) {
          return errorResult(`create_session not supported for ${args.provider}`);
        }
        const result = await provider.createSession({
          cwd: args.cwd,
          prompt: args.prompt,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
