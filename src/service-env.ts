import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CollectorConfig } from "./config.js";
import { CONFIG_DISABLED_PROVIDERS_SENTINEL } from "./config.js";
import type { CollectorCredential, SourceProvider } from "./types.js";

/**
 * The only environment keys a background service passes to the runner. A
 * service env file is read back through this allowlist, so a tampered file can
 * never inject unrelated variables (for example `NODE_OPTIONS` or `PATH`).
 */
export const SERVICE_ENV_KEYS = [
  "CODEX_HOME",
  "TRMNL_TOKEN_METER_CONFIG_DIR",
  "TRMNL_TOKEN_METER_CACHE_DIR",
  "TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS",
  "PI_HOME",
  "TRMNL_TOKEN_METER_ENABLED_PROVIDERS"
] as const;

export type ServiceEnvKey = (typeof SERVICE_ENV_KEYS)[number];

const normalizeProviderListForEnv = (providers: SourceProvider[]): string =>
  providers.length > 0 ? providers.join(",") : CONFIG_DISABLED_PROVIDERS_SENTINEL;

export function envForService(
  config: CollectorConfig,
  credential?: Pick<CollectorCredential, "enabled_providers"> | null
): Record<ServiceEnvKey, string> {
  const enabledProviders = credential?.enabled_providers ?? config.enabledProviders;
  return {
    CODEX_HOME: config.codexHome,
    TRMNL_TOKEN_METER_CONFIG_DIR: config.configDir,
    TRMNL_TOKEN_METER_CACHE_DIR: config.cacheDir,
    TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS: config.includePiSessions ? "1" : "0",
    PI_HOME: config.piSessionsHome,
    TRMNL_TOKEN_METER_ENABLED_PROVIDERS: normalizeProviderListForEnv(enabledProviders)
  };
}

/**
 * Persists the service environment for schedulers that cannot set per-job
 * environment variables (Windows Task Scheduler). The runner loads it with
 * `--service-env <path>`.
 */
export async function writeServiceEnvFile(path: string, env: Record<ServiceEnvKey, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
}

/** Reads a service env file, keeping only allowlisted string values. */
export async function readServiceEnvFile(path: string): Promise<Partial<Record<ServiceEnvKey, string>>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("Could not read the background service environment file.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The background service environment file is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  const env: Partial<Record<ServiceEnvKey, string>> = {};
  for (const key of SERVICE_ENV_KEYS) {
    const value = record[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** Applies a service env file onto `target` (normally `process.env`). */
export async function applyServiceEnvFile(
  path: string,
  target: NodeJS.ProcessEnv = process.env
): Promise<void> {
  Object.assign(target, await readServiceEnvFile(path));
}
