import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveClaudeSendTimeoutMs,
  resolveWaitTurnTimeoutMs,
  resolveWaitTurnPollMs,
  isHealthzAuthFree,
  resolveCodexModel,
  isCodexModelApiOnly,
  resolveHostId,
  resolveHostName,
  resolveClaudeMaxTurns,
  resolveClaudePermissionMode,
  resolveClaudeModelOverride,
  resolveClaudeToolList,
  resolveClaudeApprovalTimeoutMs,
  CLAUDE_APPROVAL_TIMEOUT_MS_CAP,
  splitPathList,
  CLAUDE_SEND_TIMEOUT_MS_DEFAULT,
  CLAUDE_MAX_TURNS_DEFAULT,
  CLAUDE_PERMISSION_MODE_DEFAULT,
  CLAUDE_APPROVAL_TIMEOUT_MS_DEFAULT,
  WINGMAN_WAIT_TURN_TIMEOUT_MS_DEFAULT,
  WINGMAN_WAIT_TURN_POLL_MS_DEFAULT,
  CODEX_API_ONLY_MODELS,
} from '../src/config.js';

describe('Configurable timeouts', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('resolveClaudeSendTimeoutMs', () => {
    it('returns default when env var is not set', () => {
      expect(resolveClaudeSendTimeoutMs()).toBe(CLAUDE_SEND_TIMEOUT_MS_DEFAULT);
    });

    it('returns custom value when CLAUDE_SEND_TIMEOUT_MS is set', () => {
      vi.stubEnv('CLAUDE_SEND_TIMEOUT_MS', '30000');
      expect(resolveClaudeSendTimeoutMs()).toBe(30000);
    });

    it('returns default for invalid value', () => {
      vi.stubEnv('CLAUDE_SEND_TIMEOUT_MS', 'invalid');
      expect(resolveClaudeSendTimeoutMs()).toBe(CLAUDE_SEND_TIMEOUT_MS_DEFAULT);
    });

    it('returns default for empty string', () => {
      vi.stubEnv('CLAUDE_SEND_TIMEOUT_MS', '');
      expect(resolveClaudeSendTimeoutMs()).toBe(CLAUDE_SEND_TIMEOUT_MS_DEFAULT);
    });

    it('trims whitespace from value', () => {
      vi.stubEnv('CLAUDE_SEND_TIMEOUT_MS', '  45000  ');
      expect(resolveClaudeSendTimeoutMs()).toBe(45000);
    });
  });

  describe('resolveWaitTurnTimeoutMs', () => {
    it('returns default when env var is not set', () => {
      expect(resolveWaitTurnTimeoutMs()).toBe(WINGMAN_WAIT_TURN_TIMEOUT_MS_DEFAULT);
    });

    it('returns custom value when WINGMAN_WAIT_TURN_TIMEOUT_MS is set', () => {
      vi.stubEnv('WINGMAN_WAIT_TURN_TIMEOUT_MS', '120000');
      expect(resolveWaitTurnTimeoutMs()).toBe(120000);
    });

    it('returns default for invalid value', () => {
      vi.stubEnv('WINGMAN_WAIT_TURN_TIMEOUT_MS', 'not-a-number');
      expect(resolveWaitTurnTimeoutMs()).toBe(WINGMAN_WAIT_TURN_TIMEOUT_MS_DEFAULT);
    });
  });

  describe('resolveWaitTurnPollMs', () => {
    it('returns default when env var is not set', () => {
      expect(resolveWaitTurnPollMs()).toBe(WINGMAN_WAIT_TURN_POLL_MS_DEFAULT);
    });

    it('returns custom value when WINGMAN_WAIT_TURN_POLL_MS is set', () => {
      vi.stubEnv('WINGMAN_WAIT_TURN_POLL_MS', '1000');
      expect(resolveWaitTurnPollMs()).toBe(1000);
    });
  });
});

describe('Claude turn configuration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults max turns high, not to 1', () => {
    expect(resolveClaudeMaxTurns()).toBe(CLAUDE_MAX_TURNS_DEFAULT);
    expect(CLAUDE_MAX_TURNS_DEFAULT).toBeGreaterThan(1);
  });

  it('prefers an explicit max turn budget over the env value', () => {
    vi.stubEnv('WINGMAN_CLAUDE_MAX_TURNS', '12');
    expect(resolveClaudeMaxTurns(7)).toBe(7);
    expect(resolveClaudeMaxTurns()).toBe(12);
  });

  it('caps an excessive max turn budget', () => {
    expect(resolveClaudeMaxTurns(10_000)).toBe(500);
    vi.stubEnv('WINGMAN_CLAUDE_MAX_TURNS', '9999');
    expect(resolveClaudeMaxTurns()).toBe(500);
  });

  it('ignores an invalid permission mode and an invalid max turn value', () => {
    vi.stubEnv('WINGMAN_CLAUDE_PERMISSION_MODE', 'yolo');
    vi.stubEnv('WINGMAN_CLAUDE_MAX_TURNS', 'many');
    expect(resolveClaudePermissionMode()).toBe(CLAUDE_PERMISSION_MODE_DEFAULT);
    expect(resolveClaudePermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(resolveClaudeMaxTurns()).toBe(CLAUDE_MAX_TURNS_DEFAULT);
  });

  it('does not invent a Claude model when no override is set', () => {
    expect(resolveClaudeModelOverride()).toBeUndefined();
    expect(resolveClaudeModelOverride('  ')).toBeUndefined();
    expect(resolveClaudeModelOverride('  from-call  ')).toBe('from-call');
  });

  it('reads comma-separated tool lists and leaves them unset when empty', () => {
    expect(resolveClaudeToolList(undefined, 'WINGMAN_CLAUDE_ALLOWED_TOOLS')).toBeUndefined();
    vi.stubEnv('WINGMAN_CLAUDE_ALLOWED_TOOLS', ' Read, Bash ,');
    expect(resolveClaudeToolList(undefined, 'WINGMAN_CLAUDE_ALLOWED_TOOLS')).toEqual(['Read', 'Bash']);
    expect(resolveClaudeToolList(['Edit'], 'WINGMAN_CLAUDE_ALLOWED_TOOLS')).toEqual(['Edit']);
  });

  it('defaults the approval timeout and honors an override', () => {
    expect(resolveClaudeApprovalTimeoutMs()).toBe(CLAUDE_APPROVAL_TIMEOUT_MS_DEFAULT);
    vi.stubEnv('WINGMAN_CLAUDE_APPROVAL_TIMEOUT_MS', '2500');
    expect(resolveClaudeApprovalTimeoutMs()).toBe(2500);
    expect(resolveClaudeApprovalTimeoutMs(80)).toBe(80);
    expect(resolveClaudeApprovalTimeoutMs(3_000_000_000)).toBe(CLAUDE_APPROVAL_TIMEOUT_MS_CAP);
    vi.stubEnv('WINGMAN_CLAUDE_APPROVAL_TIMEOUT_MS', '3000000000');
    expect(resolveClaudeApprovalTimeoutMs()).toBe(CLAUDE_APPROVAL_TIMEOUT_MS_CAP);
  });

  it('splits path lists on the given delimiter so Windows drive letters stay intact', () => {
    expect(splitPathList('C:\\Users\\a;D:\\work\\repo', ';')).toEqual([
      'C:\\Users\\a',
      'D:\\work\\repo',
    ]);
    expect(splitPathList('/home/a:/home/b', ':')).toEqual(['/home/a', '/home/b']);
    expect(splitPathList(undefined)).toBeUndefined();
    expect(splitPathList('   ')).toBeUndefined();
  });
});

describe('isHealthzAuthFree', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns false when env var is not set (default secure)', () => {
    expect(isHealthzAuthFree()).toBe(false);
  });

  it('returns true when WINGMAN_HEALTHZ_AUTH_FREE=1', () => {
    vi.stubEnv('WINGMAN_HEALTHZ_AUTH_FREE', '1');
    expect(isHealthzAuthFree()).toBe(true);
  });

  it('returns true when WINGMAN_HEALTHZ_AUTH_FREE=true', () => {
    vi.stubEnv('WINGMAN_HEALTHZ_AUTH_FREE', 'true');
    expect(isHealthzAuthFree()).toBe(true);
  });

  it('returns true when WINGMAN_HEALTHZ_AUTH_FREE=TRUE (case insensitive)', () => {
    vi.stubEnv('WINGMAN_HEALTHZ_AUTH_FREE', 'TRUE');
    expect(isHealthzAuthFree()).toBe(true);
  });

  it('returns false for other values', () => {
    vi.stubEnv('WINGMAN_HEALTHZ_AUTH_FREE', '0');
    expect(isHealthzAuthFree()).toBe(false);

    vi.stubEnv('WINGMAN_HEALTHZ_AUTH_FREE', 'false');
    expect(isHealthzAuthFree()).toBe(false);

    vi.stubEnv('WINGMAN_HEALTHZ_AUTH_FREE', 'yes');
    expect(isHealthzAuthFree()).toBe(false);
  });
});

describe('resolveCodexModel - model override precedence', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns explicit arg when provided (highest priority)', () => {
    vi.stubEnv('WINGMAN_CODEX_MODEL', 'model-from-env');
    expect(resolveCodexModel('model-from-arg')).toBe('model-from-arg');
  });

  it('returns WINGMAN_CODEX_MODEL when no explicit arg', () => {
    vi.stubEnv('WINGMAN_CODEX_MODEL', 'model-from-env');
    expect(resolveCodexModel()).toBe('model-from-env');
    expect(resolveCodexModel(undefined)).toBe('model-from-env');
  });

  it('returns undefined when no override is set (use Codex default)', () => {
    expect(resolveCodexModel()).toBeUndefined();
    expect(resolveCodexModel(undefined)).toBeUndefined();
  });

  it('trims whitespace from explicit arg', () => {
    expect(resolveCodexModel('  some-model  ')).toBe('some-model');
  });

  it('trims whitespace from env var', () => {
    vi.stubEnv('WINGMAN_CODEX_MODEL', '  some-model  ');
    expect(resolveCodexModel()).toBe('some-model');
  });

  it('ignores empty explicit arg and falls back to env', () => {
    vi.stubEnv('WINGMAN_CODEX_MODEL', 'model-from-env');
    expect(resolveCodexModel('')).toBe('model-from-env');
    expect(resolveCodexModel('   ')).toBe('model-from-env');
  });
});

describe('isCodexModelApiOnly', () => {
  it('detects API-only models', () => {
    for (const model of CODEX_API_ONLY_MODELS) {
      expect(isCodexModelApiOnly(model)).toBe(true);
    }
  });

  it('handles case insensitivity', () => {
    expect(isCodexModelApiOnly('GPT-6-SOL')).toBe(true);
    expect(isCodexModelApiOnly('Gpt-5-Sol')).toBe(true);
  });

  it('detects model variants with prefixes', () => {
    expect(isCodexModelApiOnly('gpt-6-sol-preview')).toBe(true);
    expect(isCodexModelApiOnly('o3-mini-high')).toBe(true);
  });

  it('returns false for models not in the API-only list', () => {
    expect(isCodexModelApiOnly('gpt-4o')).toBe(false);
    expect(isCodexModelApiOnly('gpt-4-turbo')).toBe(false);
    expect(isCodexModelApiOnly('some-other-model')).toBe(false);
  });
});

describe('Host identity configuration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolveHostId uses WINGMAN_HOST_ID when set', () => {
    vi.stubEnv('WINGMAN_HOST_ID', 'pearlwolf');
    expect(resolveHostId()).toBe('pearlwolf');
  });

  it('resolveHostId falls back to hostname when env not set', () => {
    const hostId = resolveHostId();
    expect(hostId).toBeDefined();
    expect(typeof hostId).toBe('string');
    expect(hostId.length).toBeGreaterThan(0);
  });

  it('resolveHostName uses WINGMAN_HOST_NAME when set', () => {
    vi.stubEnv('WINGMAN_HOST_NAME', 'Pearlwolf Windows');
    expect(resolveHostName()).toBe('Pearlwolf Windows');
  });

  it('resolveHostName falls back to WINGMAN_HOST_ID when name not set', () => {
    vi.stubEnv('WINGMAN_HOST_ID', 'pearlwolf');
    expect(resolveHostName()).toBe('pearlwolf');
  });

  it('resolveHostName falls back to hostname when no env set', () => {
    const hostName = resolveHostName();
    expect(hostName).toBeDefined();
    expect(typeof hostName).toBe('string');
    expect(hostName.length).toBeGreaterThan(0);
  });

  it('trims whitespace from env vars', () => {
    vi.stubEnv('WINGMAN_HOST_ID', '  pearlwolf  ');
    vi.stubEnv('WINGMAN_HOST_NAME', '  Pearlwolf Windows  ');
    expect(resolveHostId()).toBe('pearlwolf');
    expect(resolveHostName()).toBe('Pearlwolf Windows');
  });
});
