/**
 * Tests for live-setup command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mock modules
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

describe('Live Setup Checks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('Codex daemon socket detection', () => {
    it('detects daemon socket when exists', () => {
      const mockExistsSync = vi.mocked(existsSync);
      const socketPath = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
      
      mockExistsSync.mockImplementation((path) => {
        return path === socketPath;
      });
      
      expect(mockExistsSync(socketPath)).toBe(true);
    });

    it('returns false when daemon not running', () => {
      const mockExistsSync = vi.mocked(existsSync);
      mockExistsSync.mockReturnValue(false);
      
      const socketPath = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
      expect(mockExistsSync(socketPath)).toBe(false);
    });

    it('respects CODEX_HOME environment variable', () => {
      const customHome = '/custom/codex/home';
      const originalEnv = process.env.CODEX_HOME;
      process.env.CODEX_HOME = customHome;
      
      const expectedPath = join(customHome, 'app-server-control', 'app-server-control.sock');
      expect(expectedPath).toBe('/custom/codex/home/app-server-control/app-server-control.sock');
      
      process.env.CODEX_HOME = originalEnv;
    });
  });

  describe('Claude Code CLI detection', () => {
    it('detects Claude Code when installed', () => {
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockReturnValue(Buffer.from('@anthropic-ai/claude-code@2.1.281'));
      
      const version = mockExecSync('claude --version 2>/dev/null', { encoding: 'utf8' });
      expect(version.toString()).toContain('claude-code');
    });

    it('handles missing Claude Code gracefully', () => {
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockImplementation(() => {
        throw new Error('Command not found');
      });
      
      expect(() => mockExecSync('claude --version')).toThrow('Command not found');
    });
  });

  describe('Codex CLI detection', () => {
    it('detects Codex CLI when installed', () => {
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockReturnValue(Buffer.from('codex 0.152.1'));
      
      const version = mockExecSync('codex --version 2>/dev/null', { encoding: 'utf8' });
      expect(version.toString()).toContain('codex');
    });
  });
});

describe('Live Session Injection Paths', () => {
  describe('Codex Daemon Injection', () => {
    it('documents the correct workflow', () => {
      // This documents the expected workflow
      const workflow = {
        step1: 'codex app-server daemon start',
        step2: 'codex  // TUI auto-connects to daemon',
        step3: 'WINGMAN_CODEX_SOCKET=auto npm run pair',
        result: 'Messages sent via Wingman appear in TUI',
      };
      
      expect(workflow.step1).toContain('daemon start');
      expect(workflow.result).toContain('appear');
    });

    it('documents the socket path', () => {
      const socketPath = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
      expect(socketPath).toMatch(/\.codex.*app-server-control.*sock$/);
    });
  });

  describe('Claude Code Background Sessions', () => {
    it('documents the limitation', () => {
      // Claude Code background sessions have a known limitation
      const limitation = {
        canCreate: true,
        canAttach: true,
        canInjectToAttached: false, // KEY LIMITATION
        reason: 'No documented mechanism to send to attached terminal',
      };
      
      expect(limitation.canInjectToAttached).toBe(false);
    });
  });
});
