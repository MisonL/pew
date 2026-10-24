import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager, hostConfigStem } from "../config/manager.js";

describe("ConfigManager", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pew-config-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should return empty config when no file exists", async () => {
    const manager = new ConfigManager(tempDir);
    const config = await manager.load();
    expect(config).toEqual({});
  });

  it("should save and load token", async () => {
    const manager = new ConfigManager(tempDir);
    await manager.save({ token: "zb_abc123" });
    const loaded = await manager.load();
    expect(loaded.token).toBe("zb_abc123");
  });

  it("should create config directory if it does not exist", async () => {
    const configDir = join(tempDir, "nested", "config");
    const manager = new ConfigManager(configDir);
    await manager.save({ token: "test-token" });
    const loaded = await manager.load();
    expect(loaded.token).toBe("test-token");
  });

  it("should write valid JSON to disk", async () => {
    const manager = new ConfigManager(tempDir);
    await manager.save({ token: "zb_abc123" });
    const raw = await readFile(join(tempDir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.token).toBe("zb_abc123");
  });

  it("should overwrite on subsequent saves", async () => {
    const manager = new ConfigManager(tempDir);
    await manager.save({ token: "first" });
    await manager.save({ token: "second" });
    const config = await manager.load();
    expect(config.token).toBe("second");
  });

  it("should expose configPath and configDir", () => {
    const manager = new ConfigManager(tempDir);
    expect(manager.configPath).toBe(join(tempDir, "config.json"));
    expect(manager.configDir).toBe(tempDir);
  });

  it("should use config.dev.json in dev mode", () => {
    const manager = new ConfigManager(tempDir, true);
    expect(manager.configPath).toBe(join(tempDir, "config.dev.json"));
  });

  it("isolates credentials per self-hosted host", () => {
    const a = new ConfigManager(tempDir, false, "http://pew.corp:7020");
    const b = new ConfigManager(tempDir, false, "http://other.corp:7020");
    expect(a.configPath).toBe(join(tempDir, "config.pew.corp_7020.json"));
    expect(a.configPath).not.toBe(b.configPath);
    // A per-host config never collides with the SaaS default.
    const saas = new ConfigManager(tempDir, false);
    expect(saas.configPath).toBe(join(tempDir, "config.json"));
  });

  it("prefers the per-host file even in dev mode (no dev/prod collision)", () => {
    const manager = new ConfigManager(tempDir, true, "https://pew.internal");
    expect(manager.configPath).toBe(join(tempDir, "config.pew.internal.json"));
  });

  it("maps an explicit dev-host override onto config.dev.json without --dev", () => {
    // `pew login --host https://pew.dev.hexly.ai` (no --dev) used to write
    // config.json because the built-in host collapsed to "no scope" and the
    // file was then chosen by the --dev flag alone — so the dev token landed
    // in config.json and the next plain `pew sync` sent it to https://pew.md.
    const noDevFlag = new ConfigManager(tempDir, false, "https://pew.dev.hexly.ai");
    expect(noDevFlag.configPath).toBe(join(tempDir, "config.dev.json"));
    const devFlag = new ConfigManager(tempDir, true, "https://pew.dev.hexly.ai");
    expect(devFlag.configPath).toBe(join(tempDir, "config.dev.json"));
  });

  it("maps the prod host and its equivalent spellings onto config.json", () => {
    for (const host of ["https://pew.md", "https://PEW.MD", "https://pew.md:443", "https://pew.md/"]) {
      expect(new ConfigManager(tempDir, false, host).configPath).toBe(join(tempDir, "config.json"));
    }
    // A --dev flag must not divert an explicit prod-host command.
    expect(new ConfigManager(tempDir, true, "https://pew.md").configPath).toBe(join(tempDir, "config.json"));
  });

  it("keeps the SaaS file names untouched when no host is given", () => {
    expect(new ConfigManager(tempDir, false).configPath).toBe(join(tempDir, "config.json"));
    expect(new ConfigManager(tempDir, true).configPath).toBe(join(tempDir, "config.dev.json"));
  });

  it("derives a stable filename stem from host[:port] regardless of scheme", () => {
    expect(hostConfigStem("http://pew.corp:7020")).toBe("config.pew.corp_7020.json");
    expect(hostConfigStem("https://pew.corp:7020")).toBe("config.pew.corp_7020.json");
    // Ports are significant (two instances on one host must not collide).
    expect(hostConfigStem("http://pew.corp:7020")).not.toBe(hostConfigStem("http://pew.corp:7021"));
  });

  it("keeps a host literally named 'dev' out of the built-in dev credential file", () => {
    // config.dev.json is the built-in dev SaaS file. Without the reserved-stem
    // guard, an instance whose host is "dev" would write its token there, and
    // a later `pew sync --dev` would ship it to pew.dev.hexly.ai.
    expect(hostConfigStem("http://dev")).toBe("config._dev.json");
    expect(new ConfigManager(tempDir, true, "http://dev").configPath).toBe(
      join(tempDir, "config._dev.json")
    );
    expect(new ConfigManager(tempDir, true).configPath).toBe(join(tempDir, "config.dev.json"));
    // The reserved-name rewrite must not collide with a real host that is
    // literally named host-dev (the old "host-dev" prefix did).
    expect(hostConfigStem("http://host-dev")).toBe("config.host-dev.json");
    expect(hostConfigStem("http://dev")).not.toBe(hostConfigStem("http://host-dev"));
  });

  it("maps distinct host strings to distinct files (the sanitizer is injective)", () => {
    // Replacing every unsafe character with "_" merged the port separator, a
    // literal underscore and the brackets of an IPv6 literal onto one
    // character, so these pairs used to share a single credential file.
    const collisions = [
      ["http://a.b:7020", "http://a.b_7020"],
      ["http://[::1]", "http://___1_"],
      ["http://dev", "http://host-dev"],
    ];
    for (const [a, b] of collisions) {
      expect(hostConfigStem(a)).not.toBe(hostConfigStem(b));
    }
    // Ordinary host:port names stay byte-identical: existing deployments keep
    // reading the credential file they already wrote.
    expect(hostConfigStem("http://172.16.81.4:7020")).toBe("config.172.16.81.4_7020.json");
  });

  it("sanitizes characters that would escape the config directory", () => {
    // A crafted host must not introduce path separators or a ".." component.
    expect(hostConfigStem("http://../../etc/passwd")).not.toContain("/");
    expect(hostConfigStem("http://../../etc/passwd")).not.toContain("..");
  });

  it("caps the stem length so a long host cannot exceed filesystem name limits", () => {
    // A 300-char IP-literal-ish host (IPv6 with zone/padding, or a crafted
    // value) would exceed the 255-byte NAME_MAX once the prefix/suffix are
    // added, failing the write with ENAMETOOLONG instead of a clear error.
    const longHost = `http://${"a".repeat(300)}.corp:7020`;
    const stem = hostConfigStem(longHost)!;
    expect(Buffer.byteLength(stem, "utf8")).toBeLessThanOrEqual(255);
    // Still deterministic and still unique per host[:port].
    expect(hostConfigStem(longHost)).toBe(stem);
    expect(hostConfigStem(`http://${"a".repeat(301)}.corp:7020`)).not.toBe(stem);
  });

  it("getToken() returns undefined when no config exists", () => {
    const manager = new ConfigManager(tempDir);
    expect(manager.getToken()).toBeUndefined();
  });

  it("getToken() returns token after load", async () => {
    const manager = new ConfigManager(tempDir);
    await manager.save({ token: "zb_test" });
    const manager2 = new ConfigManager(tempDir);
    await manager2.load();
    expect(manager2.getToken()).toBe("zb_test");
  });

  it("isLoggedIn() returns false when no token", () => {
    const manager = new ConfigManager(tempDir);
    expect(manager.isLoggedIn()).toBe(false);
  });

  it("isLoggedIn() returns true when token exists", async () => {
    const manager = new ConfigManager(tempDir);
    await manager.save({ token: "zb_active" });
    const manager2 = new ConfigManager(tempDir);
    await manager2.load();
    expect(manager2.isLoggedIn()).toBe(true);
  });

  it("should isolate dev and prod configs", async () => {
    const prod = new ConfigManager(tempDir, false);
    const dev = new ConfigManager(tempDir, true);

    await prod.save({ token: "prod-token" });
    await dev.save({ token: "dev-token" });

    expect((await prod.load()).token).toBe("prod-token");
    expect((await dev.load()).token).toBe("dev-token");
  });

  it("should handle corrupted config file gracefully", async () => {
    await writeFile(join(tempDir, "config.json"), "not valid json{{{");
    const manager = new ConfigManager(tempDir);
    const config = await manager.load();
    expect(config).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Shared device.json tests
  // ---------------------------------------------------------------------------

  describe("ensureDeviceId (shared device.json)", () => {
    it("should generate a new UUID and write device.json on first call", async () => {
      const manager = new ConfigManager(tempDir);
      const id = await manager.ensureDeviceId();

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // Verify device.json was written
      const raw = await readFile(join(tempDir, "device.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.deviceId).toBe(id);
    });

    it("should return the same ID on subsequent calls", async () => {
      const manager = new ConfigManager(tempDir);
      const first = await manager.ensureDeviceId();
      const second = await manager.ensureDeviceId();
      expect(second).toBe(first);
    });

    it("should share device ID across dev and prod managers", async () => {
      const prod = new ConfigManager(tempDir, false);
      const dev = new ConfigManager(tempDir, true);

      const prodId = await prod.ensureDeviceId();
      const devId = await dev.ensureDeviceId();

      expect(devId).toBe(prodId);
    });

    it("should migrate deviceId from legacy prod config to device.json", async () => {
      // Simulate a legacy config.json with embedded deviceId
      const legacyId = "legacy-uuid-1234";
      await writeFile(
        join(tempDir, "config.json"),
        JSON.stringify({ token: "tk_abc", deviceId: legacyId }, null, 2),
      );

      const manager = new ConfigManager(tempDir);
      const id = await manager.ensureDeviceId();

      // Should preserve the legacy ID
      expect(id).toBe(legacyId);

      // device.json should now have it
      const deviceRaw = await readFile(join(tempDir, "device.json"), "utf-8");
      expect(JSON.parse(deviceRaw).deviceId).toBe(legacyId);

      // config.json should no longer have deviceId, but still have token
      const configRaw = await readFile(join(tempDir, "config.json"), "utf-8");
      const config = JSON.parse(configRaw);
      expect(config.token).toBe("tk_abc");
      expect(config.deviceId).toBeUndefined();
    });

    it("should migrate deviceId from legacy dev config to device.json", async () => {
      const legacyId = "dev-legacy-uuid-5678";
      await writeFile(
        join(tempDir, "config.dev.json"),
        JSON.stringify({ token: "tk_dev", deviceId: legacyId }, null, 2),
      );

      const manager = new ConfigManager(tempDir, true);
      const id = await manager.ensureDeviceId();

      expect(id).toBe(legacyId);

      // device.json written
      const deviceRaw = await readFile(join(tempDir, "device.json"), "utf-8");
      expect(JSON.parse(deviceRaw).deviceId).toBe(legacyId);

      // config.dev.json cleaned
      const configRaw = await readFile(
        join(tempDir, "config.dev.json"),
        "utf-8",
      );
      const config = JSON.parse(configRaw);
      expect(config.token).toBe("tk_dev");
      expect(config.deviceId).toBeUndefined();
    });

    it("should prefer existing device.json over legacy config deviceId", async () => {
      // device.json already exists
      const sharedId = "shared-device-id";
      await writeFile(
        join(tempDir, "device.json"),
        JSON.stringify({ deviceId: sharedId }),
      );

      // Legacy config also has a (different) deviceId
      await writeFile(
        join(tempDir, "config.json"),
        JSON.stringify({ token: "tk", deviceId: "stale-legacy-id" }),
      );

      const manager = new ConfigManager(tempDir);
      const id = await manager.ensureDeviceId();

      // Should use device.json, not legacy config
      expect(id).toBe(sharedId);
    });

    it("should handle corrupted device.json gracefully", async () => {
      await writeFile(join(tempDir, "device.json"), "not json!!!");
      const manager = new ConfigManager(tempDir);
      const id = await manager.ensureDeviceId();

      // Should generate a new ID (no legacy config to migrate from)
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should create directory when writing device.json to nested path", async () => {
      const nested = join(tempDir, "deep", "nested");
      const manager = new ConfigManager(nested);
      const id = await manager.ensureDeviceId();

      expect(id).toBeTruthy();
      const raw = await readFile(join(nested, "device.json"), "utf-8");
      expect(JSON.parse(raw).deviceId).toBe(id);
    });
  });
});
