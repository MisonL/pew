import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, readLockPid, releaseLock } from "../notifier/lockfile.js";
import { SECURE_DIR_MODE } from "./secure-mkdir.js";

const FS = { writeFile, unlink, readFile: (p: string) => readFile(p, "utf8") };

/** How long to wait for the reclamation mutex itself. */
const RECLAIM_WAIT_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Swallow an expected fs error (EEXIST / ENOENT races with other acquirers). */
const ignoreFsError = () => {
  // The lock file may be created or removed by another process between our
  // check and our write; losing that race is the normal outcome, not an error.
};

/**
 * True only when the lock names a process that no longer exists.
 *
 * Deliberately stricter than `isLockStale`: that helper treats unreadable
 * content as "nothing to protect", which is fine for a wait loop that then
 * creates the file, but here it would delete a lock another process is in the
 * middle of writing. A missing file has nothing to reclaim either, so both
 * cases return false and the caller simply retries the normal acquisition.
 */
async function namesDeadProcess(lockPath: string): Promise<boolean> {
  const pid = await readLockPid(lockPath, { fs: FS });
  if (pid === null || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Remove a `state.lock` whose owner is gone.
 *
 * A plain "read the PID, then unlink" sequence is unsafe: two reclaimers can
 * both decide the lock is stale, unlink twice, and the second unlink removes
 * the lock the first one had just created — leaving two processes believing
 * they hold it. Serializing reclamation behind its own O_EXCL mutex removes
 * that interleaving: while the mutex is held, the only way `state.lock` can
 * change is through a normal acquirer, and a normal acquirer cannot create the
 * file while the stale one still occupies the path. So after the mutex is
 * taken and the lock is re-confirmed dead, unlinking it is safe — whoever wins
 * the subsequent `wx` create is the single owner either way.
 *
 * A stale reclaim mutex is reclaimed the same way (its owner is a reclaimer,
 * never a state mutation, so that cannot cascade into the race above).
 */
async function reclaimStaleLock(lockPath: string): Promise<void> {
  const reclaimPath = `${lockPath}.reclaim`;
  const deadline = Date.now() + RECLAIM_WAIT_MS;
  let backoff = 20;
  while (true) {
    if (await acquireLock(reclaimPath, { fs: FS, process })) {
      try {
        if (await namesDeadProcess(lockPath)) await unlink(lockPath).catch(ignoreFsError);
      } finally {
        await releaseLock(reclaimPath, { fs: FS, process }).catch(ignoreFsError);
      }
      return;
    }
    if (await namesDeadProcess(reclaimPath)) {
      await unlink(reclaimPath).catch(ignoreFsError);
      continue;
    }
    if (Date.now() >= deadline) return;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 250);
  }
}

/** Serializes all Pew queue/cursor mutations, including direct CLI invocations. */
export async function withStateLock<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: SECURE_DIR_MODE });
  const path = join(stateDir, "state.lock");
  const opts = { fs: FS, process };
  if (!await acquireLock(path, opts)) {
    // A crashed run (Ctrl-C during `pew notify` is routine, SIGKILL and power
    // loss are not rare) leaves state.lock behind. Without reclamation every
    // later sync/upload/reset fails with "busy" and nothing can clear it —
    // the background sync would stay silently dead.
    await reclaimStaleLock(path);
    if (!await acquireLock(path, opts)) {
      throw new Error("Pew state is busy; retry after the active operation finishes. After a crash, verify the owner stopped before removing state.lock.");
    }
  }
  try { return await action(); }
  finally { await releaseLock(path, opts); }
}
