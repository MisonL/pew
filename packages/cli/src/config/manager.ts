import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * stable stem from host[:port], escaping anything a filesystem or the dev/prod
 * name mapping could confuse, and hashes the tail of an over-long stem.
 *
 * The mapping must be INJECTIVE. A plain "replace every unsafe char with _"
 * is not: the port separator, a literal "_" and the brackets of an IPv6
 * literal all collapsed onto the same character, so `a.b:7020` and `a.b_7020`
 * (or `[::1]` and `___1_`) shared one credential file. Only ":" — the port
 * separator, which every ordinary host:port needs — maps to a bare "_"; every
 * other non-alphanumeric, non-dot, non-hyphen character is escaped, so a stem
 * containing "_x…" can only come from such an escape and never from a literal
 * "_".
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
  const chars = [...key];
  const isLiteral = (char: string | undefined): boolean => char !== undefined && /[a-z0-9-]/i.test(char);
  let safe = "";
  for (const [index, char] of chars.entries()) {
    if (char === ".") {
      // Keep a dot only when it sits between two hostname characters, so the
      // stem can never contain ".." or a leading/trailing dot (all of which
      // could re-form a traversal component or a confusing filename). Every
      // legitimate `host.tld:port` keeps its dots, so existing credential
      // file names are byte-identical; anything else is escaped.
      if (isLiteral(chars[index - 1]) && isLiteral(chars[index + 1])) {
        safe += ".";
        continue;
      }
      safe += "_x002e";
      continue;
    }
    if (/[a-z0-9-]/i.test(char)) safe += char;
    else if (char === ":") safe += "_"; // port separator: keeps existing names
    else {
      // Escape sequences are the only source of "_x…" in a stem, which is what
      // keeps the mapping injective; a literal "_" (impossible in a WHATWG
      // URL host anyway) would also escape here.
      safe += `_x${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? ""}`;
    }
  }
  // A host literally named "dev" would produce config.dev.json — the built-in
  // dev SaaS credential file. A custom instance's token would then live in the
  // dev file, and `pew sync --dev` would send it to pew.dev.hexly.ai. The
  // replacement starts with "_dev", which no real host can produce (a literal
  // "_" always escapes to "_x005f"). Prod is config.json, which no stem equals.
  if (safe === "dev") safe = "_dev";
  // Keep the whole filename within NAME_MAX (255 bytes on ext4/APFS): a long
  // host would otherwise fail the credential write with ENAMETOOLONG. Trim to
  // a budget that leaves room for "config." + ".json", then fold the dropped
  // characters into a short hash so distinct hosts keep distinct files.
  const BUDGET = 200;
  if (safe.length > BUDGET) {
    const digest = createHash("sha256").update(safe).digest("hex").slice(0, 16);
    safe = `${safe.slice(0, BUDGET)}-${digest}`;
  }
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

  /**
   * Save config to disk. Note: this merges with existing config.
   *
   * The base class truncates the file in place. This file is the only copy of
   * the API key: a crash or ENOSPC mid-write leaves unparseable JSON, and
   * `readAsync` reports a broken file as `{}`, so the token vanishes silently
   * and the next login overwrites it. Write a sibling temp file and rename, so
   * the destination is always either the old statement or the new one.
   */
  async save(config: PewConfig): Promise<void> {
    await this.writeAtomic(config);
  }

  /** Synchronous counterpart of {@link save}. */
  override write(partial: PewConfig): void {
    const merged = { ...this.read(), ...partial };
    const tmpPath = `${this.configPath}.tmp`;
    mkdirSync(dirname(this.configPath), { recursive: true });
    try {
      writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmpPath, this.configPath);
    } catch (error) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Nothing to clean up — the write itself failed.
      }
      throw error;
    }
  }

  override async writeAsync(partial: PewConfig): Promise<void> {
    await this.writeAtomic(partial);
  }

  /**
   * Return the shared device id, creating device.json on first use.
   *
   * The base implementation writes device.json in place and, when it finds a
   * legacy `deviceId` key in the config, rewrites config.json with a bare
   * `{ ...rest }` — dropping every other credential. A torn device.json also
   * reads back as "no id" and mints a new UUID, splitting one machine's
   * history across several device rows. Keep the sync path (which reads state
   * the base cannot see) but write through a temp file, and retire the legacy
   * key through the atomic save so the rest of the config survives.
   */
  override async ensureDeviceId(): Promise<string> {
    const devicePath = join(this.configDir, "device.json");
    try {
      const data = JSON.parse(await readFile(devicePath, "utf-8")) as { deviceId?: unknown };
      if (typeof data.deviceId === "string" && data.deviceId) return data.deviceId;
    } catch {
      // Missing or unparseable file — mint a new id below.
    }

    const config = await this.readAsync();
    const legacyDeviceId = typeof config.deviceId === "string" ? config.deviceId : undefined;
    const deviceId = legacyDeviceId ?? randomUUID();

    await mkdir(this.configDir, { recursive: true });
    const tmpPath = `${devicePath}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify({ deviceId }, null, 2)}\n`, { mode: 0o600 });
      await rename(tmpPath, devicePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {
        // Best-effort cleanup — the destination was never touched.
      });
      throw error;
    }

    if (legacyDeviceId) {
      // Remove the legacy key without dropping the rest of the config.
      await this.writeAtomic({ deviceId: undefined } as PewConfig);
    }
    return deviceId;
  }

  private async writeAtomic(partial: PewConfig): Promise<void> {
    const existing = await this.readAsync();
    const merged = { ...existing, ...partial };
    const tmpPath = `${this.configPath}.tmp`;
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      await writeFile(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      await rename(tmpPath, this.configPath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {
        // Best-effort cleanup: the write failed, and a stray temp file is
        // benign — the destination was never touched.
      });
      throw error;
    }
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
