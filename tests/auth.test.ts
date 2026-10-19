import { describe, it, expect } from 'vitest';
import { secureCompare } from '../src/mcp/auth.js';

describe('secureCompare', () => {
  it('returns true for identical strings', () => {
    expect(secureCompare('abc123', 'abc123')).toBe(true);
    expect(secureCompare('', '')).toBe(true);
    expect(secureCompare('a', 'a')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(secureCompare('abc123', 'abc124')).toBe(false);
    expect(secureCompare('aaaaaa', 'aaaaab')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(secureCompare('abc', 'abcd')).toBe(false);
    expect(secureCompare('abcd', 'abc')).toBe(false);
    expect(secureCompare('', 'a')).toBe(false);
    expect(secureCompare('a', '')).toBe(false);
  });

  it('handles long tokens correctly', () => {
    const longToken = 'a'.repeat(1000);
    expect(secureCompare(longToken, longToken)).toBe(true);
    expect(secureCompare(longToken, longToken + 'b')).toBe(false);
  });

  it('handles unicode strings', () => {
    expect(secureCompare('日本語', '日本語')).toBe(true);
    expect(secureCompare('日本語', '日本人')).toBe(false);
    expect(secureCompare('émoji🎉', 'émoji🎉')).toBe(true);
    expect(secureCompare('émoji🎉', 'émoji🎊')).toBe(false);
  });

  it('handles base64url tokens (typical wingman tokens)', () => {
    const token1 = 'XvN2kL8pQmR7sT9wYzA3bC6dE5fG4hI1jK0lM-_N';
    const token2 = 'XvN2kL8pQmR7sT9wYzA3bC6dE5fG4hI1jK0lM-_O';
    expect(secureCompare(token1, token1)).toBe(true);
    expect(secureCompare(token1, token2)).toBe(false);
  });
});
