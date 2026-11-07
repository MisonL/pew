import { existsSync as exists } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

  it("still fails closed for a live owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pew-state-lock-"));
    try {
      const path = join(dir, "state.lock");
      // A live process (us) really holds it.
      const live = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
      await writeFile(path, live);
      await expect(withStateLock(dir, async () => "must not run")).rejects.toThrow("Pew state is busy");
      expect(await readFile(path, "utf8")).toBe(live);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("gives an unreadable lock one chance to finish being written", async () => {
    // `acquireLock` creates the file and then writes the JSON, so a reader can
    // catch it empty. That first unreadable observation must not delete the
    // lock: the writer completes during the recheck delay and keeps holding it.
    const dir = await mkdtemp(join(tmpdir(), "pew-state-lock-"));
    try {
      const path = join(dir, "state.lock");
      await writeFile(path, "");
      let rechecks = 0;
      await expect(withStateLock(dir, async () => "must not run", {
        sleep: async () => {
          rechecks += 1;
          await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        },
      })).rejects.toThrow("Pew state is busy");
      expect(rechecks).toBe(1);
      expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to run when a racing reclaimer replaced the lock it just created", async () => {
    // acquireLock creates the file, then writes the owner record. A reclaimer
    // that reads the file in that window sees it empty, may judge it a corpse
    // and replace it with its own lock. Running the action anyway would put
    // two processes in the load-mutate-save section at once, which is how a
    // freshly written dirtyKeys snapshot gets overwritten by a stale one.
    const dir = await mkdtemp(join(tmpdir(), "pew-state-lock-"));
    try {
      const path = join(dir, "state.lock");
      const theft = async (lockPath: string, data: string, opts?: { flag?: string }) => {
        await writeFile(lockPath, data, opts);
        if (!lockPath.endsWith(".reclaim")) {
          await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() }));
        }
      };
      await expect(withStateLock(dir, async () => "must not run", {
        lockOps: { fs: { writeFile: theft, readFile: (p) => readFile(p, "utf8"), unlink }, process },
      })).rejects.toThrow("Pew state is busy");
      // The other holder's lock must survive: releaseLock only unlinks a file
      // whose PID is our own.
      expect(exists(path)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reclaims unreadable content that persists, so a torn lock cannot wedge every command", async () => {
    // A crash or ENOSPC between the O_EXCL create and the write leaves content
    // with no parseable PID. Unlike a live owner it never becomes readable, so
    // failing closed forever would disable sync/upload/reset until an operator
    // hand-edits the state directory.
    const dir = await mkdtemp(join(tmpdir(), "pew-state-lock-"));
    try {
      const path = join(dir, "state.lock");
      await writeFile(path, "{");
      expect(await withStateLock(dir, async () => "recovered")).toBe("recovered");
      expect(await exists(path)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
