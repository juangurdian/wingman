import { CodexProvider } from './codex.js';
import { ClaudeProvider } from './claude.js';
import type { ProviderName, SessionProvider } from './types.js';

export type { ProviderName, SessionProvider } from './types.js';
export * from './types.js';

export interface ProviderRegistry {
  codex: SessionProvider;
  claude: SessionProvider;
  get(name: ProviderName): SessionProvider;
  all(): SessionProvider[];
}

export function createProviders(): ProviderRegistry {
  const codex = new CodexProvider();
  const claude = new ClaudeProvider();
  return {
    codex,
    claude,
    get(name: ProviderName) {
      return name === 'claude' ? claude : codex;
    },
    all() {
      return [codex, claude];
    },
  };
}
