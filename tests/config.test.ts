import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultCollectorDirs,
  deleteCredential,
  loadConfig,
  loadCredential,
  loadSourceNoticeState,
  saveCredential,
  saveSourceNoticeState
} from "../src/config.js";
import { parseProviders } from "../src/source-providers.js";

describe("collector config", () => {
  it("defaults to the hosted collector backend", () => {
    const config = loadConfig({});

    expect(config.apiBaseUrl).toBe("https://trmnl-token-meter-backend.trmnltkn.workers.dev");
  });

  it("loads platform paths and custom codex home from env", () => {
    const config = loadConfig({
      CODEX_HOME: "/tmp/codex-custom",
      TRMNL_TOKEN_METER_API_BASE_URL: "https://api.example.test/",
      TRMNL_TOKEN_METER_CONFIG_DIR: "/tmp/config",
      TRMNL_TOKEN_METER_CACHE_DIR: "/tmp/cache",
      TRMNL_TOKEN_METER_OPENCODE_DB: "/tmp/opencode/opencode.db",
      TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: "/tmp/claude-one,/tmp/claude-two/projects"
    });

    expect(config.apiBaseUrl).toBe("https://api.example.test");
    expect(config.codexHome).toBe(resolve("/tmp/codex-custom"));
    expect(config.codexHomeKind).toBe("custom");
    expect(config.credentialPath).toBe(resolve("/tmp/config/credentials.json"));
    expect(config.serviceDir).toBe(resolve("/tmp/config/service-runner"));
    expect(config.serviceMetadataPath).toBe(resolve("/tmp/config/service.json"));
    expect(config.serviceStatePath).toBe(resolve("/tmp/config/sync-state.json"));
    expect(config.updateCheckPath).toBe(resolve("/tmp/config/update-check.json"));
    expect(config.opencodeDbPath).toBe(resolve("/tmp/opencode/opencode.db"));
    expect(config.claudeProjectsRoots).toEqual([
      resolve("/tmp/claude-one/projects"),
      resolve("/tmp/claude-two/projects")
    ]);
  });

  it("keeps Windows config and cache under the local (non-roaming) app data folder", () => {
    expect(
      defaultCollectorDirs({ LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" }, "win32", "C:\\Users\\dev")
    ).toEqual({
      configDir: join("C:\\Users\\dev\\AppData\\Local", "trmnl-token-meter", "Config"),
      cacheDir: join("C:\\Users\\dev\\AppData\\Local", "trmnl-token-meter", "Cache")
    });
    expect(defaultCollectorDirs({}, "win32", "C:\\Users\\dev").configDir).toBe(
      join("C:\\Users\\dev", "AppData", "Local", "trmnl-token-meter", "Config")
    );
  });

  it("keeps macOS and Linux default directories unchanged", () => {
    expect(defaultCollectorDirs({}, "darwin", "/Users/dev")).toEqual({
      configDir: join("/Users/dev", "Library", "Application Support", "trmnl-token-meter"),
      cacheDir: join("/Users/dev", "Library", "Caches", "trmnl-token-meter")
    });
    expect(defaultCollectorDirs({ XDG_CONFIG_HOME: "/xdg/config" }, "linux", "/home/dev")).toEqual({
      configDir: join("/xdg/config", "trmnl-token-meter"),
      cacheDir: join("/home/dev", ".cache", "trmnl-token-meter")
    });
  });

  it("defaults enabled providers to codex when env override is missing", () => {
    const config = loadConfig({});
    expect(config.enabledProviders).toEqual(["codex"]);
  });

  it("parses TRMNL_TOKEN_METER_ENABLED_PROVIDERS with dedupe and filtering", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode,claude,unknown,opencode,codex"
    });
    expect(config.enabledProviders).toEqual(["codex", "opencode", "claude"]);
  });

  it("parses TRMNL_TOKEN_METER_ENABLED_PROVIDERS=none as explicit disable-all", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "none"
    });
    expect(config.enabledProviders).toEqual([]);
  });

  it("sanitizes persisted enabled_providers lists for unknown values", () => {
    expect(
      parseProviders(["codex", "unknown", "codex", "opencode", "", "claude", 42 as unknown], ["codex"])
    ).toEqual(["codex", "opencode", "claude"]);
  });

  it("persists credentials with the expected fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-config-"));
    const path = join(dir, "credentials.json");
    await saveCredential(path, {
      enabled_providers: ["codex", "opencode", "claude"],
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach_1",
      machine_label: "Laptop",
      upload_interval_minutes: 60
    });

    await expect(loadCredential(path)).resolves.toMatchObject({ machine_id: "mach_1" });
    await expect(readFile(path, "utf8")).resolves.toContain("collector_token");
    await deleteCredential(path);
    await expect(loadCredential(path)).resolves.toBeNull();
  });

  it("defaults source notice state to codex only when no file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-config-source-notice-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: dir
    });
    await expect(loadSourceNoticeState(config)).resolves.toEqual({
      known_supported_providers: ["codex"]
    });
  });

  it("persists source-notice state updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-config-source-notice-save-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: dir
    });
    await saveSourceNoticeState(config, { known_supported_providers: ["codex", "opencode", "claude"] });
    await expect(loadSourceNoticeState(config)).resolves.toEqual({
      known_supported_providers: ["codex", "opencode", "claude"]
    });
  });
});
