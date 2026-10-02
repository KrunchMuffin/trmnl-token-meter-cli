import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { applyServiceEnvFile, readServiceEnvFile } from "../src/service-env.js";
import {
  WINDOWS_TASK_NAME,
  headlessConsoleHost,
  installScheduledTask,
  localTaskTimestamp,
  quoteWindowsArg,
  renderScheduledTaskXml,
  scheduledTaskAction,
  scheduledTaskInstalled,
  serviceEnvPath,
  uninstallScheduledTask,
  windowsBuildNumber,
  windowsNodeLauncherCandidates
} from "../src/service-windows.js";

const tempConfig = async () => {
  const root = await mkdtemp(join(tmpdir(), "trmnl-schtasks-"));
  return loadConfig({
    CODEX_HOME: join(root, "codex"),
    TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
    TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache"),
    TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,claude"
  });
};

describe("Windows command-line quoting", () => {
  it("leaves simple arguments untouched", () => {
    expect(quoteWindowsArg("sync")).toBe("sync");
    expect(quoteWindowsArg("C:\\nodejs\\node.exe")).toBe("C:\\nodejs\\node.exe");
  });

  it("quotes paths with spaces and doubles trailing backslashes", () => {
    expect(quoteWindowsArg("C:\\Program Files\\nodejs\\node.exe")).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(quoteWindowsArg("C:\\My Dir\\")).toBe('"C:\\My Dir\\\\"');
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg('a "b"')).toBe('"a \\"b\\""');
  });
});

describe("Windows launcher and console host discovery", () => {
  it("lists stable Node.js launchers for common Windows installers", () => {
    const candidates = windowsNodeLauncherCandidates(
      { ProgramFiles: "C:\\Program Files", NVM_SYMLINK: "C:\\nvm4w\\nodejs" },
      "C:\\Users\\dev"
    );
    expect(candidates).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\nvm4w\\nodejs\\node.exe",
      "C:\\Users\\dev\\scoop\\apps\\nodejs\\current\\node.exe",
      "C:\\Users\\dev\\scoop\\apps\\nodejs-lts\\current\\node.exe"
    ]);
  });

  it("parses the Windows build number", () => {
    expect(windowsBuildNumber("10.0.22631")).toBe(22631);
    expect(windowsBuildNumber("6.1.7601")).toBe(7601);
    expect(windowsBuildNumber("garbage")).toBeNull();
  });

  it("uses a headless console host only where Windows supports it", () => {
    const env = { SystemRoot: "C:\\Windows" };
    const exists = () => true;
    expect(headlessConsoleHost(env, "10.0.19045", exists)).toBe("C:\\Windows\\System32\\conhost.exe");
    expect(headlessConsoleHost(env, "10.0.17134", exists)).toBeNull();
    expect(headlessConsoleHost(env, "10.0.19045", () => false)).toBeNull();
  });

  it("wraps the runner in the headless console host when available", () => {
    expect(scheduledTaskAction("node.exe", "cli.js", "env.json", "C:\\Windows\\System32\\conhost.exe")).toEqual({
      command: "C:\\Windows\\System32\\conhost.exe",
      args: ["--headless", "node.exe", "cli.js", "sync", "--once", "--service-env", "env.json"]
    });
    expect(scheduledTaskAction("node.exe", "cli.js", "env.json", null)).toEqual({
      command: "node.exe",
      args: ["cli.js", "sync", "--once", "--service-env", "env.json"]
    });
  });
});

describe("renderScheduledTaskXml", () => {
  const now = new Date(2026, 4, 15, 9, 30, 0);
  const action = scheduledTaskAction(
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\dev\\AppData\\Local\\trmnl-token-meter\\Config\\service-runner\\dist\\cli.js",
    "C:\\Users\\dev\\AppData\\Local\\trmnl-token-meter\\Config\\service-runner\\service-env.json",
    "C:\\Windows\\System32\\conhost.exe"
  );

  it("repeats on the upload interval and runs as the current user without elevation", () => {
    const xml = renderScheduledTaskXml({ action, intervalMinutes: 15, runAtLoad: true, now, userId: "DESKTOP\\dev" });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain("<Interval>PT15M</Interval>");
    expect(xml).toContain(`<StartBoundary>${localTaskTimestamp(new Date(2026, 4, 15, 9, 31, 0))}</StartBoundary>`);
    expect(xml).toContain("<UserId>DESKTOP\\dev</UserId>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
    expect(xml).toContain(
      "<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; " +
        "C:\\Users\\dev\\AppData\\Local\\trmnl-token-meter\\Config\\service-runner\\dist\\cli.js sync --once " +
        "--service-env C:\\Users\\dev\\AppData\\Local\\trmnl-token-meter\\Config\\service-runner\\service-env.json</Arguments>"
    );
  });

  it("defers the first run of a repaired task by a full interval", () => {
    const xml = renderScheduledTaskXml({ action, intervalMinutes: 60, runAtLoad: false, now, userId: null });

    expect(xml).toContain(`<StartBoundary>${localTaskTimestamp(new Date(2026, 4, 15, 10, 30, 0))}</StartBoundary>`);
    expect(xml).not.toContain("<UserId>");
  });

  it("escapes XML metacharacters in paths and user names", () => {
    const xml = renderScheduledTaskXml({
      action: { command: "C:\\R&D\\node.exe", args: ["C:\\<dir>\\cli.js"] },
      intervalMinutes: 5,
      runAtLoad: true,
      now,
      userId: "R&D\\dev"
    });

    expect(xml).toContain("<Command>C:\\R&amp;D\\node.exe</Command>");
    expect(xml).toContain("<Arguments>C:\\&lt;dir&gt;\\cli.js</Arguments>");
    expect(xml).toContain("<UserId>R&amp;D\\dev</UserId>");
  });
});

describe("Windows Task Scheduler install", () => {
  it("registers the task from UTF-16 XML and writes the allowlisted service env", async () => {
    const config = await tempConfig();
    const calls: string[][] = [];
    let xmlBytes: Buffer | null = null;

    await installScheduledTask(
      config,
      join(config.serviceDir, "dist", "cli.js"),
      15,
      "node.exe",
      true,
      async (file, args) => {
        calls.push([file, ...args]);
        const xmlIndex = args.indexOf("/XML");
        if (xmlIndex >= 0) xmlBytes = await readFile(args[xmlIndex + 1]!);
      },
      { enabled_providers: ["codex", "opencode"] }
    );

    expect(calls).toEqual([
      ["schtasks", "/Create", "/TN", WINDOWS_TASK_NAME, "/XML", join(config.cacheDir, "scheduled-task.xml"), "/F"]
    ]);
    expect(xmlBytes).not.toBeNull();
    const bytes = xmlBytes as unknown as Buffer;
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toContain("<Interval>PT15M</Interval>");
    await expect(readFile(join(config.cacheDir, "scheduled-task.xml"))).rejects.toThrow();

    await expect(readServiceEnvFile(serviceEnvPath(config))).resolves.toEqual({
      CODEX_HOME: config.codexHome,
      TRMNL_TOKEN_METER_CONFIG_DIR: config.configDir,
      TRMNL_TOKEN_METER_CACHE_DIR: config.cacheDir,
      TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS: "0",
      PI_HOME: config.piSessionsHome,
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode"
    });
  });

  it("removes the XML even when schtasks rejects it", async () => {
    const config = await tempConfig();
    await expect(
      installScheduledTask(config, "cli.js", 15, "node.exe", true, async () => {
        throw new Error("ERROR: Access is denied.");
      })
    ).rejects.toThrow("Access is denied");
    await expect(readFile(join(config.cacheDir, "scheduled-task.xml"))).rejects.toThrow();
  });

  it("queries and deletes the task by name", async () => {
    const config = await tempConfig();
    const calls: string[][] = [];
    const record = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
    };

    await expect(scheduledTaskInstalled(record)).resolves.toBe(true);
    await expect(
      scheduledTaskInstalled(async () => {
        throw new Error("ERROR: The system cannot find the file specified.");
      })
    ).resolves.toBe(false);
    await installScheduledTask(config, "cli.js", 15, "node.exe", true, record);
    await uninstallScheduledTask(config, record);

    expect(calls).toContainEqual(["schtasks", "/Query", "/TN", WINDOWS_TASK_NAME]);
    expect(calls).toContainEqual(["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
    await expect(readFile(serviceEnvPath(config))).rejects.toThrow();
  });
});

describe("service env file", () => {
  it("applies only allowlisted keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trmnl-service-env-"));
    const path = join(dir, "service-env.json");
    await writeFile(
      path,
      JSON.stringify({
        CODEX_HOME: "C:\\Users\\dev\\.codex",
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex",
        NODE_OPTIONS: "--require evil.js",
        PATH: "C:\\evil",
        PI_HOME: 42
      })
    );
    const target: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };

    await applyServiceEnvFile(path, target);

    expect(target).toEqual({
      PATH: "C:\\Windows",
      CODEX_HOME: "C:\\Users\\dev\\.codex",
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex"
    });
  });

  it("fails without echoing the file path or contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trmnl-service-env-"));
    const missing = join(dir, "missing.json");
    const malformed = join(dir, "malformed.json");
    await writeFile(malformed, "[1, 2]");

    await expect(readServiceEnvFile(missing)).rejects.toThrow(
      "Could not read the background service environment file."
    );
    await expect(readServiceEnvFile(malformed)).rejects.toThrow(
      "The background service environment file is malformed."
    );
  });
});
