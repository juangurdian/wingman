import { describe, it, expect } from 'vitest';
import { maskToken } from '../src/config.js';

describe('maskToken', () => {
  it('masks tokens showing first 4 characters and ellipsis', () => {
    expect(maskToken('abcd1234567890')).toBe('abcd…');
    expect(maskToken('XvN2kL8pQmR7sT9wYzA3')).toBe('XvN2…');
  });

  it('returns **** for tokens <= 4 characters', () => {
    expect(maskToken('abcd')).toBe('****');
    expect(maskToken('abc')).toBe('****');
    expect(maskToken('ab')).toBe('****');
    expect(maskToken('a')).toBe('****');
    expect(maskToken('')).toBe('****');
  });

  it('works with exactly 5 characters', () => {
    expect(maskToken('abcde')).toBe('abcd…');
  });

  it('works with typical base64url tokens', () => {
    const token = 'XvN2kL8pQmR7sT9wYzA3bC6dE5fG4hI1jK0lM-_N';
    expect(maskToken(token)).toBe('XvN2…');
  });
});
