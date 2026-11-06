import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPiHook, uninstallPiHook, getPiHookStatus } from "../notifier/pi-hook.js";

describe("pi-hook", () => {
  let testDir: string;
  let extensionPath: string;
  const notifyPath = "/home/test/.config/pew/bin/notify.cjs";

  beforeEach(async () => {
    testDir = join(tmpdir(), `pew-pi-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    extensionPath = join(testDir, "pew-sync.ts");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("installPiHook", () => {
    it("creates extension file with correct content", async () => {
      const result = await installPiHook({ extensionPath, notifyPath });
      expect(result.source).toBe("pi");
      expect(result.action).toBe("install");
      expect(result.changed).toBe(true);

      const content = await readFile(extensionPath, "utf8");
      expect(content).toContain("PEW_PI_HOOK");
      expect(content).toContain("session_shutdown");
      expect(content).toContain(notifyPath);
      expect(content).toContain("--source=pi");
    });

    it("reports unchanged if already installed", async () => {
      await installPiHook({ extensionPath, notifyPath });
      const result = await installPiHook({ extensionPath, notifyPath });
      expect(result.changed).toBe(false);
      expect(result.detail).toContain("already installed");
    });

    it("updates if content differs", async () => {
      await writeFile(extensionPath, "// PEW_PI_HOOK\nold content\n", "utf8");
      const result = await installPiHook({ extensionPath, notifyPath });
      expect(result.changed).toBe(true);

      const content = await readFile(extensionPath, "utf8");
      expect(content).toContain("session_shutdown");
    });

    // install used to overwrite any file at that path. uninstall and status
    // both treat "file without our marker" as not-pew's, so install destroyed
    // exactly what the other two refused to touch.
    it("refuses to replace an extension pew does not own", async () => {
      const foreign = "// my own pi extension\nexport default function () {}\n";
      await writeFile(extensionPath, foreign, "utf8");
      const result = await installPiHook({ extensionPath, notifyPath });
      expect(result.changed).toBe(false);
      expect(result.detail).toContain("ownership_conflict");
      expect(result.warnings?.length).toBeGreaterThan(0);
      expect(await readFile(extensionPath, "utf8")).toBe(foreign);
    });
  });

  describe("uninstallPiHook", () => {
    it("removes extension file", async () => {
      await installPiHook({ extensionPath, notifyPath });
      const result = await uninstallPiHook({ extensionPath, notifyPath });
      expect(result.source).toBe("pi");
      expect(result.action).toBe("uninstall");
      expect(result.changed).toBe(true);
    });

    it("skips if file not found", async () => {
      const result = await uninstallPiHook({ extensionPath, notifyPath });
      expect(result.action).toBe("skip");
      expect(result.changed).toBe(false);
    });

    it("skips if file not managed by pew", async () => {
      await writeFile(extensionPath, "// some other extension\n", "utf8");
      const result = await uninstallPiHook({ extensionPath, notifyPath });
      expect(result.action).toBe("skip");
      expect(result.changed).toBe(false);
    });

    // Reporting success here was not cosmetic: `pew uninstall` removes the
    // shared notify.cjs only when every driver is warning-free, so claiming
    // "removed" while the file stayed on disk left an extension invoking a
    // deleted handler.
    it("reports a removal that failed instead of claiming the hook is gone", async () => {
      await installPiHook({ extensionPath, notifyPath });
      const result = await uninstallPiHook({
        extensionPath,
        notifyPath,
        fs: {
          readFile,
          writeFile,
          mkdir,
          unlink: async () => {
            throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
          },
        },
      });
      expect(result.changed).toBe(false);
      expect(result.action).not.toBe("uninstall");
      expect(result.warnings?.length).toBeGreaterThan(0);
      expect(await readFile(extensionPath, "utf8")).toContain("PEW_PI_HOOK");
    });
  });

  describe("getPiHookStatus", () => {
    it("returns installed when hook exists", async () => {
      await installPiHook({ extensionPath, notifyPath });
      const status = await getPiHookStatus({ extensionPath, notifyPath });
      expect(status).toBe("installed");
    });

    it("returns not-installed when hook missing", async () => {
      const status = await getPiHookStatus({ extensionPath, notifyPath });
      expect(status).toBe("not-installed");
    });

    it("returns not-installed when file exists but no marker", async () => {
      await writeFile(extensionPath, "// other extension\n", "utf8");
      const status = await getPiHookStatus({ extensionPath, notifyPath });
      expect(status).toBe("not-installed");
    });
  });
});
