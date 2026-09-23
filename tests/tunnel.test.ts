import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('Tunnel helpers', () => {
  const testConfigDir = join(homedir(), '.wingman-test-tunnel');

  beforeEach(() => {
    vi.stubEnv('CLAUDE_MOCK', '1');
    vi.stubEnv('CODEX_MOCK', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true });
    }
  });

  it('detectBinary returns found:false for non-existent binary', async () => {
    const { detectBinary } = await import('../src/tunnel.js');
    const result = detectBinary('nonexistent-binary-xyz123');
    expect(result.found).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it('detectBinary returns found:true for node', async () => {
    const { detectBinary } = await import('../src/tunnel.js');
    const result = detectBinary('node');
    expect(result.found).toBe(true);
    expect(result.version).toBeDefined();
  });

  it('detectCloudflared returns TunnelTool structure', async () => {
    const { detectCloudflared } = await import('../src/tunnel.js');
    const result = detectCloudflared();

    expect(result.name).toBe('Cloudflare Tunnel (cloudflared)');
    expect(result.binary).toBe('cloudflared');
    expect(typeof result.installed).toBe('boolean');
    expect(result.recommendation).toBe('quick-tunnel');
  });

  it('detectTailscale returns TunnelTool structure', async () => {
    const { detectTailscale } = await import('../src/tunnel.js');
    const result = detectTailscale();

    expect(result.name).toBe('Tailscale');
    expect(result.binary).toBe('tailscale');
    expect(typeof result.installed).toBe('boolean');
    expect(result.recommendation).toBe('tailscale-serve');
  });

  it('detectAllTunnelTools returns array of tools', async () => {
    const { detectAllTunnelTools } = await import('../src/tunnel.js');
    const tools = detectAllTunnelTools();

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.binary)).toContain('tailscale');
    expect(tools.map((t) => t.binary)).toContain('cloudflared');
  });

  it('generateTunnelCommands returns expected commands', async () => {
    const { generateTunnelCommands } = await import('../src/tunnel.js');
    const commands = generateTunnelCommands(3847, '127.0.0.1');

    expect(commands.length).toBe(4);
    expect(commands.map((c) => c.durability)).toEqual([
      'stable',
      'stable',
      'stable',
      'ephemeral',
    ]);

    const quickTunnel = commands.find((c) => c.tool.includes('Quick Tunnel'));
    expect(quickTunnel).toBeDefined();
    expect(quickTunnel?.command).toContain('cloudflared tunnel --url');
    expect(quickTunnel?.command).toContain('3847');

    const tailscaleServe = commands.find((c) => c.tool.includes('Tailscale Serve'));
    expect(tailscaleServe).toBeDefined();
    expect(tailscaleServe?.command).toBe('tailscale serve --bg 3847');
  });

  it('getRankedRecommendations prioritizes installed tools', async () => {
    const { getRankedRecommendations, TunnelTool } = await import('../src/tunnel.js');

    const mockTools: TunnelTool[] = [
      {
        name: 'Tailscale',
        binary: 'tailscale',
        installed: true,
        recommendation: 'tailscale-serve',
      },
      {
        name: 'Cloudflare Tunnel',
        binary: 'cloudflared',
        installed: false,
        recommendation: 'quick-tunnel',
      },
    ];

    const ranked = getRankedRecommendations(mockTools, 3847, '127.0.0.1');
    expect(ranked[0].tool).toContain('Tailscale Serve');
    expect(ranked[1].tool).toContain('Tailscale Funnel');
    expect(ranked.length).toBe(2);
  });

  it('getRankedRecommendations returns all when both installed', async () => {
    const { getRankedRecommendations, TunnelTool } = await import('../src/tunnel.js');

    const mockTools: TunnelTool[] = [
      {
        name: 'Tailscale',
        binary: 'tailscale',
        installed: true,
        recommendation: 'tailscale-serve',
      },
      {
        name: 'Cloudflare Tunnel',
        binary: 'cloudflared',
        installed: true,
        recommendation: 'quick-tunnel',
      },
    ];

    const ranked = getRankedRecommendations(mockTools, 3847, '127.0.0.1');
    expect(ranked.length).toBe(4);
    expect(ranked[0].tool).toContain('Tailscale Serve');
    expect(ranked[ranked.length - 1].tool).toContain('Quick Tunnel');
  });

  it('isWindows returns boolean based on platform', async () => {
    const { isWindows } = await import('../src/tunnel.js');
    const result = isWindows();
    expect(typeof result).toBe('boolean');
  });

  it('loadTunnelState returns null when no state exists', async () => {
    const { loadTunnelState } = await import('../src/tunnel.js');
    const state = loadTunnelState();
    expect(state === null || state?.tokenHintPath !== undefined).toBe(true);
  });

  it('TunnelCommand has required fields', async () => {
    const { generateTunnelCommands } = await import('../src/tunnel.js');
    const commands = generateTunnelCommands(3847, '127.0.0.1');

    for (const cmd of commands) {
      expect(cmd).toHaveProperty('tool');
      expect(cmd).toHaveProperty('command');
      expect(cmd).toHaveProperty('description');
      expect(cmd).toHaveProperty('durability');
      expect(['stable', 'semi-stable', 'ephemeral']).toContain(cmd.durability);
    }
  });

  it('generateTunnelCommands includes port in commands', async () => {
    const { generateTunnelCommands } = await import('../src/tunnel.js');
    const port = 8888;
    const commands = generateTunnelCommands(port, '127.0.0.1');

    const tailscaleCmd = commands.find((c) => c.tool.includes('Tailscale Serve'));
    expect(tailscaleCmd?.command).toContain(port.toString());

    const quickTunnelCmd = commands.find((c) => c.tool.includes('Quick Tunnel'));
    expect(quickTunnelCmd?.command).toContain(port.toString());
  });
});
