import { ConfigManager as BaseConfigManager } from "@nocoo/base-cli";
import type { PewConfig } from "@pew/core";

// The SaaS host URLs live here rather than in commands/login.ts so every
// credential reader (CLI commands, upload engine) can apply one rule without
// importing a command module.
export const DEFAULT_HOST = "https://pew.md";
export const DEV_HOST = "https://pew.dev.hexly.ai";

const PROD_CONFIG = "config.json";
const DEV_CONFIG = "config.dev.json";

/**
 * Turn a self-hosted API URL into a filesystem-safe config filename suffix.
 *
 * Distinct hosts must not share a token file (spec §4.5): logging into one
 * intranet instance must not overwrite credentials for another. Derives a
 * stable stem from host[:port] and hashes the rest so unusual characters or
 * long paths cannot escape the config directory.
 */
export function hostConfigStem(host: string | undefined): string | undefined {
  if (!host) return undefined;
  let key = host;
  try {
    const u = new URL(host.includes("://") ? host : `https://${host}`);
    key = u.host; // host[:port], no protocol/path — stable across http/https
  } catch {
    // Not a parseable URL — fall back to the raw string.
  }
  let safe = key
    .replace(/\.\./g, "_") // no parent-directory traversal
    .replace(/[^a-z0-9.-]/gi, "_"); // no separators or other unsafe chars
  // A host literally named "dev" would produce config.dev.json — the built-in
  // dev SaaS credential file. A custom instance's token would then live in the
  // dev file, and `pew sync --dev` would send it to pew.dev.hexly.ai. Prefix
  // the one colliding stem (prod is config.json, which no stem can equal).
  if (safe === "dev") safe = "host-dev";
  return `config.${safe}.json`;
}

/**
 * The host scope a command must use when reading or writing credentials.
 *
 * Every command that touches credentials derives the SAME scope from its own
 * resolved API URL, so `login`, `sync` and `logout` always agree on the file.
 *
 * The two built-in SaaS hosts are returned as-is (normalized) rather than as
 * undefined: `ConfigManager` maps them onto the historical `config.json` /
 * `config.dev.json`, so their file names never change. They must NOT be
 * collapsed to "no scope" here — the file choice would then fall back to the
 * `--dev` flag alone, and `pew login --host https://pew.dev.hexly.ai` (no
 * `--dev`) would write the dev token into `config.json`, where the next plain
 * `pew sync` sends it to https://pew.md.
 */
export function credentialHostScope(apiUrl: string | undefined): string | undefined {
  if (!apiUrl) return undefined;
  const raw = apiUrl.trim();
  if (!raw) return undefined;
  try {
    // `origin` lowercases the host, drops the default port and strips
    // credentials/path/query, so `https://PEW.MD:443/` and `https://pew.md`
    // select the same file.
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return u.origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/**
 * Pew-specific configuration manager.
 * Extends base-cli ConfigManager with pew-specific helpers.
 *
 * - Production: ~/.config/pew/config.json
 * - Dev:        ~/.config/pew/config.dev.json
 * - Self-hosted (host given): ~/.config/pew/config.<host>.json
 * - Device ID:  ~/.config/pew/device.json (shared across environments)
 */
export class ConfigManager extends BaseConfigManager<PewConfig> {
  /**
   * @param configDir Directory holding config files
   * @param dev       Whether dev mode is active (config.dev.json)
   * @param host      Optional self-hosted API URL; isolates credentials per host
   */
  constructor(configDir: string, dev = false, host?: string) {
    // A built-in SaaS host keeps its historical file name; every other host
    // gets a file of its own. The host therefore wins over `dev` in BOTH
    // slots: a command that passes https://pew.dev.hexly.ai must use
    // config.dev.json whether or not --dev was given, or the dev token lands
    // in config.json and the next plain `pew sync` sends it to https://pew.md.
    const scope = credentialHostScope(host);
    const filename =
      scope === DEFAULT_HOST ? PROD_CONFIG
      : scope === DEV_HOST ? DEV_CONFIG
      : hostConfigStem(scope);
    super(configDir, dev, {
      prodFilename: filename,
      devFilename: filename,
    });
  }

  /** Load config from disk (async). Alias for readAsync(). */
  load(): Promise<PewConfig> {
    return this.readAsync();
  }

  /** Save config to disk. Note: this merges with existing config. */
  save(config: PewConfig): Promise<void> {
    return this.writeAsync(config);
  }

  /** Get the authentication token. */
  getToken(): string | undefined {
    return this.get("token") as string | undefined;
  }

  /** Check if user is logged in. */
  isLoggedIn(): boolean {
    return !!this.getToken();
  }
}
