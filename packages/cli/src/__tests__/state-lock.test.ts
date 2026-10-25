import { existsSync as exists } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withStateLock } from "../storage/state-lock.js";

describe("state mutation lock", () => {
  it("excludes competing mutations and releases after a failed transaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pew-state-lock-"));
    try {
      await expect(withStateLock(dir, async () => {
        await expect(withStateLock(dir, async () => { throw new Error("must not run"); })).rejects.toThrow("Pew state is busy");
        throw new Error("transaction failed");
      })).rejects.toThrow("transaction failed");
      expect(await withStateLock(dir, async () => "recovered")).toBe("recovered");
      // A lock whose owner is dead is reclaimed instead of wedging every
      // later command: a crashed `pew notify` must not disable sync forever.
      const path = join(dir, "state.lock");
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      await writeFile(path, JSON.stringify({ pid: Number(dead.stdout), startedAt: new Date().toISOString() }));
      expect(await withStateLock(dir, async () => "after crash")).toBe("after crash");
      expect(await exists(path)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("still fails closed for a live owner and for content it cannot interpret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pew-state-lock-"));
    try {
      const path = join(dir, "state.lock");
      // A live process (us) really holds it.
      await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await expect(withStateLock(dir, async () => "must not run")).rejects.toThrow("Pew state is busy");
      // Unparseable content is treated as "cannot verify the owner" — never
      // silently deleted, because it might be a lock being written right now.
      await writeFile(path, "{");
      await expect(withStateLock(dir, async () => "must not run")).rejects.toThrow("Pew state is busy");
      expect(await readFile(path, "utf8")).toBe("{");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
