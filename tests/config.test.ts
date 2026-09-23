import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveClaudeSendTimeoutMs,
  resolveWaitTurnTimeoutMs,
  resolveWaitTurnPollMs,
  isHealthzAuthFree,
  CLAUDE_SEND_TIMEOUT_MS_DEFAULT,
  WINGMAN_WAIT_TURN_TIMEOUT_MS_DEFAULT,
  WINGMAN_WAIT_TURN_POLL_MS_DEFAULT,
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
