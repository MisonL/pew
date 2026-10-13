import { ConfigManager as BaseConfigManager } from "@nocoo/base-cli";
import type { PewConfig } from "@pew/core";

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
export function hostConfigStem(host: string): string {
  let key = host;
  try {
    const u = new URL(host.includes("://") ? host : `https://${host}`);
    key = u.host; // host[:port], no protocol/path — stable across http/https
  } catch {
    // Not a parseable URL — fall back to the raw string.
  }
  const safe = key
    .replace(/\.\./g, "_") // no parent-directory traversal
    .replace(/[^a-z0-9.-]/gi, "_"); // no separators or other unsafe chars
  return `config.${safe}.json`;
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
    // A self-hosted host gets its own file, taking precedence over dev/prod so
    // a per-host token never collides with the SaaS default.
    const perHost = host ? hostConfigStem(host) : undefined;
    super(configDir, dev, {
      prodFilename: perHost ?? PROD_CONFIG,
      devFilename: perHost ?? DEV_CONFIG,
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
