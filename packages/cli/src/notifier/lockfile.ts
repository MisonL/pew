/**
 * O_EXCL-based lockfile with PID-based stale detection.
 *
 * Provides cross-process mutual exclusion that works on all Node.js/Bun
 * versions (unlike FileHandle.lock() which requires Node 22+).
 *
 * The lockfile contains `{ pid, startedAt }` JSON. Stale detection uses
 * `process.kill(pid, 0)` — PID-only, no age-based checks (a slow fetch()
 * is still a valid lock holder).
 */

// ---------------------------------------------------------------------------
// Dependency injection interfaces
// ---------------------------------------------------------------------------

export interface LockFsOps {
  writeFile(
    path: string,
    data: string,
    options?: { flag?: string },
  ): Promise<void>;
  readFile(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
}

export interface ProcessOps {
  readonly pid: number;
  kill(pid: number, signal: number): boolean;
}

// ---------------------------------------------------------------------------
// acquireLock — O_EXCL atomic create
// ---------------------------------------------------------------------------

/**
 * Try to create the lockfile atomically (O_EXCL).
 *
 * @returns `true` if acquired, `false` if another lockfile already exists.
 * @throws On unexpected fs errors (not EEXIST).
 */
export async function acquireLock(
  lockPath: string,
  opts: { fs: LockFsOps; process: ProcessOps },
): Promise<boolean> {
  const content = JSON.stringify({
    pid: opts.process.pid,
    startedAt: new Date().toISOString(),
  });
  try {
    await opts.fs.writeFile(lockPath, content, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// releaseLock — unlink only if we own the lockfile
// ---------------------------------------------------------------------------

/**
 * Release the lockfile by unlinking it, but only if the PID inside matches
 * our own. Silently handles all errors (lockfile already gone, permission
 * issues, corrupted content).
 */
export async function releaseLock(
  lockPath: string,
  opts: { fs: LockFsOps; process: ProcessOps },
): Promise<void> {
  try {
    const pid = await readLockPid(lockPath, { fs: opts.fs });
    if (pid !== opts.process.pid) return;
    await opts.fs.unlink(lockPath);
  } catch {
    // Best-effort cleanup — don't let release failures propagate
  }
}

// ---------------------------------------------------------------------------
// readLockPid — parse PID from lockfile content
// ---------------------------------------------------------------------------

/**
 * Read and parse the PID from a lockfile.
 *
 * @returns The PID number, or `null` if the file doesn't exist or is
 *          corrupted/unparseable.
 */
export async function readLockPid(
  lockPath: string,
  opts: { fs: Pick<LockFsOps, "readFile"> },
): Promise<number | null> {
  try {
    const content = await opts.fs.readFile(lockPath);
    const parsed = JSON.parse(content);
    if (typeof parsed?.pid === "number") return parsed.pid;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lock owner state — read the lock once, decide once
// ---------------------------------------------------------------------------

/**
 * Who currently holds the lock.
 *
 * - `missing` — no lockfile; acquisition should simply succeed.
 * - `alive` — the recorded PID exists (or is our own). Never reclaim.
 * - `dead` — the recorded PID is gone (ESRCH). Safe to reclaim.
 * - `unreadable` — the file exists but has no parseable PID. This is also the
 *   shape of a lock another process just created and is still writing, so it
 *   must not be treated as dead on sight.
 */
export type LockOwnerState = "missing" | "alive" | "dead" | "unreadable";

export async function readLockOwnerState(
  lockPath: string,
  opts: { fs: Pick<LockFsOps, "readFile">; process: ProcessOps },
): Promise<LockOwnerState> {
  let content: string;
  try {
    content = await opts.fs.readFile(lockPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "missing" : "unreadable";
  }

  let pid: unknown;
  try {
    pid = (JSON.parse(content) as { pid?: unknown } | null)?.pid;
  } catch {
    return "unreadable";
  }
  if (typeof pid !== "number") return "unreadable";
  if (pid === opts.process.pid) return "alive";

  try {
    opts.process.kill(pid, 0);
    return "alive";
  } catch (err) {
    // EPERM means the process exists but we may not signal it.
    return (err as NodeJS.ErrnoException | undefined)?.code === "ESRCH" ? "dead" : "alive";
  }
}

// ---------------------------------------------------------------------------
// reclaimLock — remove a stale lockfile without racing another reclaimer
// ---------------------------------------------------------------------------

/** How long to wait for the reclamation mutex itself. */
const RECLAIM_WAIT_MS = 2_000;

/**
 * Remove a lockfile whose owner is gone, serialized behind a `<lock>.reclaim`
 * O_EXCL mutex.
 *
 * A bare "read the PID, then unlink" sequence is unsafe: two reclaimers can
 * both observe the dead PID, and the second unlink removes the lock the first
 * one had just created — leaving two processes believing they hold it. The
 * mutex removes that interleaving: while it is held the only way the lock can
 * change is through a normal acquirer, and an acquirer cannot create the file
 * while the stale one still occupies the path. The owner state is re-read
 * under the mutex, so a lock that was re-created after the caller's check
 * survives.
 *
 * `allowUnreadable` permits reclaiming content with no parseable PID. Only a
 * caller that has watched the file stay unreadable across polls may pass it:
 * the first unreadable observation is indistinguishable from a lock being
 * written right now.
 */
export async function reclaimLock(
  lockPath: string,
  opts: {
    fs: LockFsOps;
    process: ProcessOps;
    allowUnreadable: boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const reclaimPath = `${lockPath}.reclaim`;
  const deadline = now() + RECLAIM_WAIT_MS;
  let backoff = 20;

  while (true) {
    if (await acquireLock(reclaimPath, { fs: opts.fs, process: opts.process })) {
      try {
        const state = await readLockOwnerState(lockPath, opts);
        const reclaimable = state === "dead" || (opts.allowUnreadable && state === "unreadable");
        if (reclaimable) {
          try {
            await opts.fs.unlink(lockPath);
          } catch {
            // Another reclaimer or the owner released it first — fine.
          }
        }
      } finally {
        try {
          await releaseLock(reclaimPath, { fs: opts.fs, process: opts.process });
        } catch {
          // Best-effort mutex cleanup.
        }
      }
      return;
    }

    // A stale reclaim mutex is reclaimed the same way — its owner is a
    // reclaimer, never a lock holder, so this cannot cascade into the race.
    if ((await readLockOwnerState(reclaimPath, opts)) === "dead") {
      try {
        await opts.fs.unlink(reclaimPath);
      } catch {
        // Another reclaimer won — retry the mutex acquisition.
      }
      continue;
    }

    if (now() >= deadline) return;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 250);
  }
}

// ---------------------------------------------------------------------------
// waitForLock — poll with exponential backoff
// ---------------------------------------------------------------------------

export interface WaitForLockResult {
  acquired: boolean;
  error?: string;
}

/**
 * Poll for the lockfile to become available with exponential backoff.
 *
 * If the current holder's PID is dead, removes the stale lockfile and
 * retries acquisition. Gives up after `timeoutMs`.
 *
 * Backoff: starts at 100ms, doubles each iteration, caps at 2000ms.
 */
export async function waitForLock(
  lockPath: string,
  opts: {
    fs: LockFsOps;
    process: ProcessOps;
    timeoutMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<WaitForLockResult> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const startTime = now();
  let backoff = 100;
  const maxBackoff = 2000;
  // Consecutive polls that saw a lockfile with no parseable owner. One
  // observation is a lock being written right now; a persistent one is a
  // corrupt file left by a crash, and only then may it be reclaimed.
  let unreadablePolls = 0;

  while (true) {
    const acquired = await acquireLock(lockPath, {
      fs: opts.fs,
      process: opts.process,
    });
    if (acquired) return { acquired: true };

    const state = await readLockOwnerState(lockPath, opts);
    if (state === "dead") {
      await reclaimLock(lockPath, { ...opts, allowUnreadable: false });
    } else if (state === "unreadable") {
      unreadablePolls += 1;
      if (unreadablePolls >= 2) {
        await reclaimLock(lockPath, { ...opts, allowUnreadable: true });
      }
    } else {
      unreadablePolls = 0;
    }

    if (state === "dead" || unreadablePolls >= 2) {
      // A reclaim may have freed the path; do not make the caller pay a
      // full backoff before trying again.
      if (
        await acquireLock(lockPath, { fs: opts.fs, process: opts.process })
      ) {
        return { acquired: true };
      }
    }

    const elapsed = now() - startTime;
    if (elapsed >= opts.timeoutMs) {
      return { acquired: false, error: "lock timeout" };
    }

    await sleep(backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}
