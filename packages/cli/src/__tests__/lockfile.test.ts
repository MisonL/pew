import { describe, expect, it } from "vitest";
import {
  acquireLock,
  releaseLock,
  reclaimLock,
  readLockOwnerState,
  waitForLock,
  readLockPid,
  type LockFsOps,
  type ProcessOps,
} from "../notifier/lockfile.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal fake fs that tracks lockfiles in memory, keyed by path. Keying
 * matters: reclamation uses a `<lock>.reclaim` mutex beside the lock, so a
 * single shared slot would make the mutex and the lock appear to be the same
 * file.
 */
function createFakeFs(opts?: {
  lockContent?: string | null;
  readThrows?: Error;
  writeThrows?: Error;
  unlinkThrows?: Error;
}): LockFsOps & {
  _state: { files: Map<string, string>; unlinks: string[] };
  /** The primary lockfile's content, or null when unlocked. */
  _content: string | null;
} {
  const state = {
    files: new Map<string, string>(),
    unlinks: [] as string[],
  };
  if (opts?.lockContent != null) state.files.set("/tmp/sync.lock", opts.lockContent);

  const fake = {
    _content: null as string | null,
    _state: state,

    async writeFile(path: string, data: string, options?: { flag?: string }) {
      if (opts?.writeThrows) throw opts.writeThrows;
      if (options?.flag === "wx" && state.files.has(path)) {
        const err = new Error("EEXIST") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      state.files.set(path, data);
    },

    async readFile(path: string): Promise<string> {
      if (opts?.readThrows) throw opts.readThrows;
      const content = state.files.get(path);
      if (content === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    },

    async unlink(path: string): Promise<void> {
      if (opts?.unlinkThrows) throw opts.unlinkThrows;
      state.unlinks.push(path);
      state.files.delete(path);
    },
  };

  return {
    ...fake,
    get _content(): string | null { return state.files.get("/tmp/sync.lock") ?? null; },
    set _content(value: string | null) {
      if (value === null) state.files.delete("/tmp/sync.lock");
      else state.files.set("/tmp/sync.lock", value);
    },
  };
}

function createFakeProcess(opts?: {
  pid?: number;
  killThrows?: Map<number, string>;
}): ProcessOps {
  const pid = opts?.pid ?? 12345;
  const killThrows = opts?.killThrows ?? new Map();

  return {
    pid,
    kill(targetPid: number, _signal: number): boolean {
      const errCode = killThrows.get(targetPid);
      if (errCode) {
        const err = new Error(errCode) as NodeJS.ErrnoException;
        err.code = errCode;
        throw err;
      }
      return true;
    },
  };
}

function lockContent(pid: number, startedAt = "2026-03-20T01:00:00.000Z"): string {
  return JSON.stringify({ pid, startedAt });
}

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

describe("acquireLock", () => {
  it("creates a lockfile with O_EXCL when no lockfile exists", async () => {
    const fs = createFakeFs();
    const proc = createFakeProcess({ pid: 9999 });

    const result = await acquireLock("/tmp/sync.lock", { fs, process: proc });

    expect(result).toBe(true);
    expect(fs._content).not.toBeNull();
    const parsed = JSON.parse(fs._content!);
    expect(parsed.pid).toBe(9999);
    expect(parsed.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns false when lockfile already exists (EEXIST)", async () => {
    const fs = createFakeFs({ lockContent: lockContent(8888) });
    const proc = createFakeProcess({ pid: 9999 });

    const result = await acquireLock("/tmp/sync.lock", { fs, process: proc });

    expect(result).toBe(false);
    // Original lockfile unchanged
    const parsed = JSON.parse(fs._content!);
    expect(parsed.pid).toBe(8888);
  });

  it("throws on unexpected write errors (not EEXIST)", async () => {
    const err = new Error("EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    const fs = createFakeFs({ writeThrows: err });
    const proc = createFakeProcess();

    await expect(
      acquireLock("/tmp/sync.lock", { fs, process: proc }),
    ).rejects.toThrow("EACCES");
  });
});

// ---------------------------------------------------------------------------
// releaseLock
// ---------------------------------------------------------------------------

describe("releaseLock", () => {
  it("removes lockfile when PID matches", async () => {
    const fs = createFakeFs({ lockContent: lockContent(9999) });
    const proc = createFakeProcess({ pid: 9999 });

    await releaseLock("/tmp/sync.lock", { fs, process: proc });

    expect(fs._content).toBeNull();
  });

  it("does NOT remove lockfile when PID does not match", async () => {
    const fs = createFakeFs({ lockContent: lockContent(8888) });
    const proc = createFakeProcess({ pid: 9999 });

    await releaseLock("/tmp/sync.lock", { fs, process: proc });

    // Lockfile still exists with original PID
    expect(fs._content).not.toBeNull();
    const parsed = JSON.parse(fs._content!);
    expect(parsed.pid).toBe(8888);
  });

  it("silently handles lockfile already removed (ENOENT on read)", async () => {
    const fs = createFakeFs({ lockContent: null });
    const proc = createFakeProcess({ pid: 9999 });

    // Should not throw
    await releaseLock("/tmp/sync.lock", { fs, process: proc });
  });

  it("silently handles unlink failure", async () => {
    const err = new Error("EPERM") as NodeJS.ErrnoException;
    err.code = "EPERM";
    const fs = createFakeFs({
      lockContent: lockContent(9999),
      unlinkThrows: err,
    });
    const proc = createFakeProcess({ pid: 9999 });

    // Should not throw
    await releaseLock("/tmp/sync.lock", { fs, process: proc });
  });

  it("silently handles corrupted lockfile content (unparseable JSON)", async () => {
    const fs = createFakeFs({ lockContent: "not json" });
    const proc = createFakeProcess({ pid: 9999 });

    // Should not throw
    await releaseLock("/tmp/sync.lock", { fs, process: proc });
  });
});

// ---------------------------------------------------------------------------
// readLockPid
// ---------------------------------------------------------------------------

describe("readLockPid", () => {
  it("returns the PID from a valid lockfile", async () => {
    const fs = createFakeFs({ lockContent: lockContent(12345) });
    const pid = await readLockPid("/tmp/sync.lock", { fs });
    expect(pid).toBe(12345);
  });

  it("returns null when lockfile does not exist", async () => {
    const fs = createFakeFs({ lockContent: null });
    const pid = await readLockPid("/tmp/sync.lock", { fs });
    expect(pid).toBeNull();
  });

  it("returns null when lockfile content is corrupted", async () => {
    const fs = createFakeFs({ lockContent: "garbage" });
    const pid = await readLockPid("/tmp/sync.lock", { fs });
    expect(pid).toBeNull();
  });

  it("returns null when lockfile JSON has no pid field", async () => {
    const fs = createFakeFs({ lockContent: JSON.stringify({ startedAt: "x" }) });
    const pid = await readLockPid("/tmp/sync.lock", { fs });
    expect(pid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readLockOwnerState
// ---------------------------------------------------------------------------

describe("readLockOwnerState", () => {
  it("reports dead when the PID is gone (ESRCH)", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({
      pid: 9999,
      killThrows: new Map([[7777, "ESRCH"]]),
    });

    expect(await readLockOwnerState("/tmp/sync.lock", { fs, process: proc })).toBe("dead");
  });

  it("reports alive when the PID exists", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({ pid: 9999 });

    expect(await readLockOwnerState("/tmp/sync.lock", { fs, process: proc })).toBe("alive");
  });

  it("reports alive on EPERM — the process exists, we just cannot signal it", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({
      pid: 9999,
      killThrows: new Map([[7777, "EPERM"]]),
    });

    expect(await readLockOwnerState("/tmp/sync.lock", { fs, process: proc })).toBe("alive");
  });

  it("reports missing when there is no lockfile", async () => {
    const fs = createFakeFs({ lockContent: null });
    const proc = createFakeProcess();

    expect(await readLockOwnerState("/tmp/sync.lock", { fs, process: proc })).toBe("missing");
  });

  it("reports unreadable — not dead — for corrupt content", async () => {
    // A just-created lockfile is briefly empty: O_EXCL creates it before the
    // owner's content lands. Treating that as dead deletes a live lock.
    const fs = createFakeFs({ lockContent: "not json" });
    const proc = createFakeProcess();

    expect(await readLockOwnerState("/tmp/sync.lock", { fs, process: proc })).toBe("unreadable");
  });

  it("reports alive for our own PID (self-check)", async () => {
    const fs = createFakeFs({ lockContent: lockContent(9999) });
    const proc = createFakeProcess({ pid: 9999 });

    expect(await readLockOwnerState("/tmp/sync.lock", { fs, process: proc })).toBe("alive");
  });
});

// ---------------------------------------------------------------------------
// reclaimLock
// ---------------------------------------------------------------------------

describe("reclaimLock", () => {
  it("removes a lockfile whose owner is dead", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({
      pid: 9999,
      killThrows: new Map([[7777, "ESRCH"]]),
    });

    await reclaimLock("/tmp/sync.lock", {
      fs,
      process: proc,
      allowUnreadable: false,
      sleep: async () => {},
    });

    expect(fs._content).toBeNull();
  });

  it("leaves a live owner's lockfile alone", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({ pid: 9999 });

    await reclaimLock("/tmp/sync.lock", {
      fs,
      process: proc,
      allowUnreadable: false,
      sleep: async () => {},
    });

    expect(fs._content).toBe(lockContent(7777));
  });

  it("does not delete a lock that another process created while we waited", async () => {
    // The race this guards: two reclaimers both read the dead PID; the first
    // reclaims and a new owner takes the lock; the second must not unlink the
    // fresh lock. The reclaimer re-reads under its mutex, so a replacement is
    // seen as alive.
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({
      pid: 9999,
      killThrows: new Map([[7777, "ESRCH"]]),
    });

    // While reclaimer A holds the mutex, simulate reclaimer B's stale decision
    // by having the lock replaced by a new owner after the caller's check.
    const originalRead = fs.readFile.bind(fs);
    let reads = 0;
    fs.readFile = async (path: string) => {
      reads += 1;
      // First read (the caller's check) sees the dead owner; every later read
      // sees the replacement, as if it happened while waiting for the mutex.
      if (reads === 1) return originalRead(path);
      return lockContent(8888);
    };

    // The caller's own pre-check: this is the observation that says "dead".
    expect(await readLockOwnerState("/tmp/sync.lock", { fs, process: proc })).toBe("dead");

    await reclaimLock("/tmp/sync.lock", {
      fs,
      process: proc,
      allowUnreadable: false,
      sleep: async () => {},
    });

    // 8888 is alive in this fake, so the replacement lock must survive.
    expect(fs._content).not.toBeNull();
  });

  it("reclaims corrupt content only when the caller has confirmed it is stale", async () => {
    const fs = createFakeFs({ lockContent: "not json" });
    const proc = createFakeProcess({ pid: 9999 });

    await reclaimLock("/tmp/sync.lock", {
      fs,
      process: proc,
      allowUnreadable: false,
      sleep: async () => {},
    });
    expect(fs._content).toBe("not json");

    await reclaimLock("/tmp/sync.lock", {
      fs,
      process: proc,
      allowUnreadable: true,
      sleep: async () => {},
    });
    expect(fs._content).toBeNull();
  });

  it("reclaims a stale reclaim mutex left by a dead reclaimer", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    fs._state.files.set("/tmp/sync.lock.reclaim", lockContent(6666));
    const proc = createFakeProcess({
      pid: 9999,
      killThrows: new Map([
        [7777, "ESRCH"],
        [6666, "ESRCH"],
      ]),
    });

    await reclaimLock("/tmp/sync.lock", {
      fs,
      process: proc,
      allowUnreadable: false,
      sleep: async () => {},
    });

    expect(fs._content).toBeNull();
    expect(fs._state.files.has("/tmp/sync.lock.reclaim")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForLock
// ---------------------------------------------------------------------------

describe("waitForLock", () => {
  it("acquires the lock immediately if lockfile becomes available on first try", async () => {
    const fs = createFakeFs({ lockContent: null });
    const proc = createFakeProcess({ pid: 9999 });

    const result = await waitForLock("/tmp/sync.lock", {
      fs,
      process: proc,
      timeoutMs: 5000,
    });

    expect(result.acquired).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("acquires the lock after stale lockfile is removed", async () => {
    // Lock held by dead process
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({
      pid: 9999,
      killThrows: new Map([[7777, "ESRCH"]]),
    });

    const result = await waitForLock("/tmp/sync.lock", {
      fs,
      process: proc,
      timeoutMs: 10000,
      sleep: async () => {},
    });

    expect(result.acquired).toBe(true);
  });

  it("times out when lock is held by a live process", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({ pid: 9999 });
    // PID 7777 is alive (kill doesn't throw)

    let elapsed = 0;
    const fakeSleep = async (ms: number) => {
      elapsed += ms;
    };

    // Use a short timeout and simulate time passing via fakeSleep
    const result = await waitForLock("/tmp/sync.lock", {
      fs,
      process: proc,
      timeoutMs: 500,
      sleep: fakeSleep,
      now: () => elapsed,
    });

    expect(result.acquired).toBe(false);
    expect(result.error).toContain("lock timeout");
  });

  it("acquires the lock after the holder releases it mid-poll", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({ pid: 9999 });
    // PID 7777 is alive initially

    let pollCount = 0;
    const fakeSleep = async () => {
      pollCount++;
      if (pollCount >= 2) {
        // Simulate lock released after 2 polls
        fs._content = null;
      }
    };

    const result = await waitForLock("/tmp/sync.lock", {
      fs,
      process: proc,
      timeoutMs: 60000,
      sleep: fakeSleep,
    });

    expect(result.acquired).toBe(true);
  });

  it("does not reclaim corrupt content on the first poll, but does once it persists", async () => {
    // A lockfile with no PID is also the shape of one being written right
    // now. The first observation must be given a chance to become readable;
    // only a file that stays unreadable is treated as crash debris.
    const fs = createFakeFs({ lockContent: "" });
    const proc = createFakeProcess({ pid: 9999 });
    let polls = 0;
    const sleeps: number[] = [];
    let elapsed = 0;

    const result = await waitForLock("/tmp/sync.lock", {
      fs,
      process: proc,
      timeoutMs: 10000,
      sleep: async (ms) => {
        polls += 1;
        sleeps.push(ms);
        elapsed += ms;
        if (polls === 1) {
          // The writer finishes; a real lock now occupies the path.
          fs._content = lockContent(7777);
        }
      },
      now: () => elapsed,
    });

    // The transient empty file was not deleted: the live lock stayed and the
    // waiter timed out rather than stealing it.
    expect(result.acquired).toBe(false);
    expect(fs._content).toBe(lockContent(7777));
    expect(sleeps[0]).toBe(100);

    // A file that never becomes readable is reclaimed and acquired.
    const stuck = createFakeFs({ lockContent: "" });
    const second = await waitForLock("/tmp/sync.lock", {
      fs: stuck,
      process: proc,
      timeoutMs: 10000,
      sleep: async () => {},
    });
    expect(second.acquired).toBe(true);
  });

  it("does not delete a lock another waiter acquired after reclamation", async () => {
    // Two waiters see the same dead owner. The first reclaims and acquires;
    // the second's reclaim must observe the new live owner, not the dead one
    // it saw before, and must therefore leave the lock alone.
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const procA = createFakeProcess({
      pid: 1001,
      killThrows: new Map([[7777, "ESRCH"]]),
    });
    const procB = createFakeProcess({
      pid: 1002,
      killThrows: new Map([[7777, "ESRCH"]]),
    });

    const a = await waitForLock("/tmp/sync.lock", {
      fs,
      process: procA,
      timeoutMs: 10000,
      sleep: async () => {},
    });
    expect(a.acquired).toBe(true);
    const holderPid = JSON.parse(fs._content!).pid;
    expect(holderPid).toBe(1001);

    // B's kill() now also reports 1001 as alive, so its reclaim leaves it be.
    const b = await waitForLock("/tmp/sync.lock", {
      fs,
      process: procB,
      timeoutMs: 200,
      sleep: async () => {},
      now: (() => { let t = 0; return () => { t += 100; return t; }; })(),
    });
    expect(b.acquired).toBe(false);
    expect(JSON.parse(fs._content!).pid).toBe(1001);
  });

  it("uses exponential backoff starting at 100ms, capped at 2000ms", async () => {
    const fs = createFakeFs({ lockContent: lockContent(7777) });
    const proc = createFakeProcess({ pid: 9999 });
    // PID 7777 is alive → lock never becomes available

    const sleepDurations: number[] = [];
    let elapsed = 0;
    const fakeSleep = async (ms: number) => {
      sleepDurations.push(ms);
      elapsed += ms;
    };

    await waitForLock("/tmp/sync.lock", {
      fs,
      process: proc,
      timeoutMs: 10000,
      sleep: fakeSleep,
      now: () => elapsed,
    });

    // Verify backoff pattern: 100, 200, 400, 800, 1600, 2000 (capped), 2000, ...
    expect(sleepDurations[0]).toBe(100);
    expect(sleepDurations[1]).toBe(200);
    expect(sleepDurations[2]).toBe(400);
    expect(sleepDurations[3]).toBe(800);
    expect(sleepDurations[4]).toBe(1600);
    expect(sleepDurations[5]).toBe(2000);
    // After cap, all should be 2000
    if (sleepDurations.length > 6) {
      expect(sleepDurations[6]).toBe(2000);
    }
  });
});
