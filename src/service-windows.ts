import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, release } from "node:os";
import { join, win32 } from "node:path";
import type { CollectorConfig } from "./config.js";
import { envForService, writeServiceEnvFile } from "./service-env.js";
import type { CollectorCredential } from "./types.js";

export const WINDOWS_TASK_NAME = "trmnl-token-meter-sync";

/** First Windows 10 build (1809) whose console host supports `--headless`. */
const HEADLESS_CONHOST_MIN_BUILD = 17763;

type CommandRunner = (file: string, args: string[]) => Promise<void>;

/**
 * Stable Node.js launchers on Windows. The official installer, winget and
 * Chocolatey all use `%ProgramFiles%\nodejs`; nvm-windows keeps `%NVM_SYMLINK%`
 * pointed at the active version; Scoop keeps a `current` junction per app.
 */
export function windowsNodeLauncherCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  const candidates: string[] = [];
  const programFiles = env.ProgramFiles?.trim() || "C:\\Program Files";
  candidates.push(win32.join(programFiles, "nodejs", "node.exe"));
  if (env.NVM_SYMLINK?.trim()) candidates.push(win32.join(env.NVM_SYMLINK.trim(), "node.exe"));
  const scoopRoot = env.SCOOP?.trim() || win32.join(home, "scoop");
  candidates.push(win32.join(scoopRoot, "apps", "nodejs", "current", "node.exe"));
  candidates.push(win32.join(scoopRoot, "apps", "nodejs-lts", "current", "node.exe"));
  return candidates;
}

/** Parses the build number out of `os.release()` (`10.0.22631` → 22631). */
export function windowsBuildNumber(osRelease: string): number | null {
  const build = Number(osRelease.split(".")[2]);
  return Number.isInteger(build) && build > 0 ? build : null;
}

/**
 * Returns the console host to wrap the scheduled job in so that no console
 * window flashes on screen every interval, or null when it is unavailable and
 * Node.js has to be started directly.
 */
export function headlessConsoleHost(
  env: NodeJS.ProcessEnv = process.env,
  osRelease = release(),
  exists: (path: string) => boolean = existsSync
): string | null {
  const build = windowsBuildNumber(osRelease);
  if (build === null || build < HEADLESS_CONHOST_MIN_BUILD) return null;
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  const conhost = win32.join(systemRoot, "System32", "conhost.exe");
  return exists(conhost) ? conhost : null;
}

/**
 * Quotes one argument for the Windows command line (CommandLineToArgvW rules),
 * so paths with spaces or trailing backslashes reach Node.js intact.
 */
export function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const pad = (value: number): string => String(value).padStart(2, "0");

/** Task Scheduler boundaries without a zone are interpreted as local time. */
export function localTaskTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export interface ScheduledTaskAction {
  command: string;
  args: string[];
}

export function scheduledTaskAction(
  launcher: string,
  runner: string,
  serviceEnvPath: string,
  consoleHost: string | null
): ScheduledTaskAction {
  const nodeArgs = [runner, "sync", "--once", "--service-env", serviceEnvPath];
  if (!consoleHost) return { command: launcher, args: nodeArgs };
  return { command: consoleHost, args: ["--headless", launcher, ...nodeArgs] };
}

export function renderScheduledTaskXml(options: {
  action: ScheduledTaskAction;
  intervalMinutes: number;
  runAtLoad: boolean;
  now?: Date;
  userId?: string | null;
}): string {
  const interval = Math.max(1, options.intervalMinutes);
  const now = options.now ?? new Date();
  // Mirrors launchd RunAtLoad / systemd OnBootSec: an install runs shortly after
  // registration, while a repair waits for the next full interval.
  const startDelayMinutes = options.runAtLoad ? 1 : interval;
  const start = new Date(now.getTime() + startDelayMinutes * 60_000);
  const userId = options.userId?.trim();
  const args = options.action.args.map(quoteWindowsArg).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Uploads sanitized TRMNL Token Meter usage aggregates.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${interval}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${localTaskTimestamp(start)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
${userId ? `      <UserId>${xmlEscape(userId)}</UserId>\n` : ""}      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(quoteWindowsArg(options.action.command))}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function serviceEnvPath(config: CollectorConfig): string {
  return join(config.serviceDir, "service-env.json");
}

const currentWindowsUser = (env: NodeJS.ProcessEnv): string | null => {
  const user = env.USERNAME?.trim();
  if (!user) return null;
  const domain = env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${user}` : user;
};

export async function installScheduledTask(
  config: CollectorConfig,
  runner: string,
  intervalMinutes: number,
  launcher: string,
  runAtLoad: boolean,
  runCommand: CommandRunner,
  credential?: Pick<CollectorCredential, "enabled_providers"> | null
): Promise<void> {
  const envPath = serviceEnvPath(config);
  await writeServiceEnvFile(envPath, envForService(config, credential));
  const xml = renderScheduledTaskXml({
    action: scheduledTaskAction(launcher, runner, envPath, headlessConsoleHost()),
    intervalMinutes,
    runAtLoad,
    userId: currentWindowsUser(process.env)
  });
  await mkdir(config.cacheDir, { recursive: true, mode: 0o700 });
  const xmlPath = join(config.cacheDir, "scheduled-task.xml");
  // schtasks only reliably imports task XML encoded as UTF-16 with a BOM.
  await writeFile(xmlPath, Buffer.from(`\ufeff${xml}`, "utf16le"), { mode: 0o600 });
  try {
    await runCommand("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", xmlPath, "/F"]);
  } finally {
    await rm(xmlPath, { force: true });
  }
}

export async function uninstallScheduledTask(
  config: CollectorConfig,
  runCommand: CommandRunner
): Promise<void> {
  await runCommand("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]).catch(() => undefined);
  await rm(serviceEnvPath(config), { force: true });
}

export async function scheduledTaskInstalled(runCommand: CommandRunner): Promise<boolean> {
  try {
    await runCommand("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}
