import { CodexProvider } from './codex.js';
import { ClaudeProvider } from './claude.js';
import { MuseProvider } from './muse.js';
import type { ProviderName, SessionProvider } from './types.js';

export type { ProviderName, SessionProvider } from './types.js';
export * from './types.js';

export interface ProviderRegistry {
  codex: SessionProvider;
  claude: SessionProvider;
  muse: SessionProvider;
  get(name: ProviderName): SessionProvider;
  all(): SessionProvider[];
}

export function createProviders(): ProviderRegistry {
  const codex = new CodexProvider();
  const claude = new ClaudeProvider();
  const muse = new MuseProvider();
  return {
    codex,
    claude,
    muse,
    get(name: ProviderName) {
      if (name === 'claude') return claude;
      if (name === 'muse') return muse;
      return codex;
    },
    all() {
      return [codex, claude, muse];
    },
  };
}
