import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, readLockOwnerState, reclaimLock, releaseLock } from "../notifier/lockfile.js";
import { ensureSecureDir } from "./secure-mkdir.js";

const FS = { writeFile, unlink, readFile: (p: string) => readFile(p, "utf8") };

const LOCK_OPS = { fs: FS, process };

/**
 * How long to wait before re-observing a lock whose contents have no
 * parseable PID. Mirrors waitForLock's "two observations" rule: the first
 * unreadable read cannot be told apart from a lock another process created
 * and has not finished writing.
 */
const UNREADABLE_RECHECK_MS = 100;

const BUSY_MESSAGE =
  "Pew state is busy; retry after the active operation finishes. After a crash, verify the owner stopped before removing state.lock.";

/** Test seam: the recheck delay is the only timing this module owns. */
export interface StateLockDeps {
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Try to take the lock, reclaiming it if its owner is gone.
 *
 * Two separate staleness cases, and they need different evidence:
 *
 * - A parseable PID that no longer exists is dead on sight — no waiting can
 *   make it alive again.
 * - Unreadable content is ambiguous. `acquireLock` creates the file with
 *   O_EXCL and *then* writes the JSON, so a reader can catch it empty; the
 *   same shape is left behind by a crash or ENOSPC between the create and the
 *   write. Reclaiming on the first observation would delete a lock that a
 *   live process is about to finish writing. Waiting and looking again
 *   separates the two: a lock that is still unreadable after the delay is a
 *   corpse, and leaving it in place would wedge every later command forever.
 */
async function reclaimAndAcquire(
  path: string,
  opts: typeof LOCK_OPS,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  await reclaimLock(path, { ...opts, allowUnreadable: false });
  if (await acquireLock(path, opts)) return true;

  await sleep(UNREADABLE_RECHECK_MS);
  if ((await readLockOwnerState(path, opts)) === "unreadable") {
    await reclaimLock(path, { ...opts, allowUnreadable: true });
  }
  // Always retry, even when the recheck said "alive" or "missing": the state
  // can change between the read and here, and a free lock should be taken.
  return acquireLock(path, opts);
}

/** Serializes all Pew queue/cursor mutations, including direct CLI invocations. */
export async function withStateLock<T>(
  stateDir: string,
  action: () => Promise<T>,
  deps: StateLockDeps = {},
): Promise<T> {
  await ensureSecureDir(stateDir, { recursive: true });
  const path = join(stateDir, "state.lock");
  const opts = LOCK_OPS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // A crashed run (Ctrl-C during `pew notify` is routine, SIGKILL and power
  // loss are not rare) leaves state.lock behind. Without reclamation every
  // later sync/upload/reset fails with "busy" and nothing can clear it —
  // the background sync would stay silently dead.
  if (!await acquireLock(path, opts) && !await reclaimAndAcquire(path, opts, sleep)) {
    throw new Error(BUSY_MESSAGE);
  }
  try { return await action(); }
  finally { await releaseLock(path, opts); }
}
