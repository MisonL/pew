import type * as Fs from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ path: "", error: null as NodeJS.ErrnoException | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]) === fault.path && fault.error) throw fault.error;
      return actual.readFileSync(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === fault.path && fault.error) throw fault.error;
      return actual.readFile(...args);
    },
  };
});

import { ConfigManager } from "../config/manager.js";

describe("configuration read failures", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pew-config-read-")); });
  afterEach(async () => {
    fault.error = null;
    fault.path = "";
    await rm(dir, { recursive: true, force: true });
  });

  describe.each(["EACCES", "EIO", "EMFILE"])("%s", (code) => {
    it("does not replace unread credentials during an asynchronous merge", async () => {
      const manager = new ConfigManager(dir);
      const before = '{"token":"synthetic-token","deviceId":"legacy-id"}\n';
      await writeFile(manager.configPath, before);
      fault.path = manager.configPath;
      fault.error = Object.assign(new Error("synthetic read failure"), { code });
      await expect(manager.save({ extra: "new value" })).rejects.toThrow(/config state/i);
      fault.error = null;
      expect(await readFile(manager.configPath, "utf8")).toBe(before);
      expect(await readdir(dir)).toEqual(["config.json"]);
    });

    it("does not replace unread credentials during a synchronous merge", async () => {
      const manager = new ConfigManager(dir);
      const before = '{"token":"synthetic-token","deviceId":"legacy-id"}\n';
      await writeFile(manager.configPath, before);
      fault.path = manager.configPath;
      fault.error = Object.assign(new Error("synthetic read failure"), { code });
      expect(() => manager.write({ extra: "new value" })).toThrow(/config state/i);
      fault.error = null;
      expect(await readFile(manager.configPath, "utf8")).toBe(before);
      expect(await readdir(dir)).toEqual(["config.json"]);
    });

    it("reports an unread config instead of reporting logged out", async () => {
      const manager = new ConfigManager(dir);
      await writeFile(manager.configPath, '{"token":"synthetic-token"}');
      fault.path = manager.configPath;
      fault.error = Object.assign(new Error("synthetic read failure"), { code });
      await expect(manager.load()).rejects.toThrow(/config state/i);
      expect(() => manager.isLoggedIn()).toThrow(/config state/i);
    });
  });
});
