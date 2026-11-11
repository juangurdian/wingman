/**
 * Windows Scheduled Task that starts Wingman at logon and boot and restarts it
 * after a crash. The task command never passes --new-token, so the bearer
 * token in the user profile stays stable across restarts.
 */

export type TaskTunnel = 'none' | 'tailscale' | 'quick';

export interface WindowsTaskPlan {
  taskName: string;
  nodePath: string;
  scriptPath: string;
  xml: string;
  /** schtasks invocation. The XML file path is filled in by the installer. */
  createCommand: string;
  tokenFlag: '--new-token' | null;
  tunnel: TaskTunnel;
  notes: string[];
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildWindowsTaskPlan(input: {
  taskName?: string;
  nodePath: string;
  scriptPath: string;
  tunnel?: TaskTunnel;
  tailscaleBin?: string;
}): WindowsTaskPlan {
  const taskName = input.taskName?.trim() || 'Wingman';
  const nodePath = input.nodePath;
  const scriptPath = input.scriptPath;
  const tunnel = input.tunnel ?? 'none';
  if (/\s--new-token\b|--new-token/.test(scriptPath) || /\s--new-token\b|--new-token/.test(input.tailscaleBin ?? '')) {
    throw new Error('Refusing to install a task whose script path contains --new-token.');
  }

  const extra: string[] = [];
  if (tunnel === 'tailscale') extra.push('--ensure-tunnel', 'tailscale');
  if (tunnel === 'quick') extra.push('--ensure-tunnel', 'quick');
  if (input.tailscaleBin?.trim()) {
    const bin = input.tailscaleBin.trim();
    extra.push('--tailscale-bin', bin.includes(' ') ? `"${bin}"` : bin);
  }
  const argumentText = [`"${scriptPath}"`, ...extra].join(' ');
  if (argumentText.includes('--new-token')) {
    throw new Error('Refusing to install a task that passes --new-token.');
  }

  const tunnelNote =
    tunnel === 'tailscale'
      ? ' The task also passes --ensure-tunnel tailscale. Funnel --bg persists in tailscaled, so the check republishes the port only when it is not already active.'
      : tunnel === 'quick'
        ? ' The task also passes --ensure-tunnel quick. A quick tunnel is a process, and its hostname changes every start.'
        : '';

  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Wingman MCP bridge. Reuses the bearer token in the user profile across restarts.${xmlEscape(tunnelNote)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodePath)}</Command>
      <Arguments>${xmlEscape(argumentText)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;

  return {
    taskName,
    nodePath,
    scriptPath,
    xml,
    createCommand: `schtasks /Create /TN "${taskName}" /XML "<path-to-xml>" /F`,
    tokenFlag: null,
    tunnel,
    notes: [
      'The command is node plus pair.js. It does not pass --new-token, so a crash restart reuses the token already in the user profile.',
      'LogonTrigger runs as the user who installed the task, which is the account that owns %USERPROFILE%\\.wingman\\config.json.',
      'BootTrigger is included so the task is eligible at startup. Task Scheduler still runs it as that user, not as a fresh token.',
      'RestartOnFailure waits one minute and retries. ExecutionTimeLimit PT0S means the bridge is not killed for running a long time.',
      tunnel === 'tailscale'
        ? 'Tailscale Funnel --bg is stored by tailscaled. The task checks that the funnel is active and republishes the port only when it is not.'
        : tunnel === 'quick'
          ? 'The quick tunnel option starts cloudflared in the background. The trycloudflare.com URL changes every start. Prefer tailscale when the URL must stay put.'
          : 'Pass --tunnel tailscale or --tunnel quick to wingman-task install when the task should also ensure a tunnel.',
    ],
  };
}
