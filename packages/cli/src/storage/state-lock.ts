import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, reclaimLock, releaseLock } from "../notifier/lockfile.js";
import { ensureSecureDir } from "./secure-mkdir.js";

const FS = { writeFile, unlink, readFile: (p: string) => readFile(p, "utf8") };

const LOCK_OPS = { fs: FS, process };

/** Serializes all Pew queue/cursor mutations, including direct CLI invocations. */
export async function withStateLock<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  await ensureSecureDir(stateDir, { recursive: true });
  const path = join(stateDir, "state.lock");
  const opts = LOCK_OPS;
  if (!await acquireLock(path, opts)) {
    // A crashed run (Ctrl-C during `pew notify` is routine, SIGKILL and power
    // loss are not rare) leaves state.lock behind. Without reclamation every
    // later sync/upload/reset fails with "busy" and nothing can clear it —
    // the background sync would stay silently dead.
    await reclaimLock(path, { ...opts, allowUnreadable: false });
    if (!await acquireLock(path, opts)) {
      throw new Error("Pew state is busy; retry after the active operation finishes. After a crash, verify the owner stopped before removing state.lock.");
    }
  }
  try { return await action(); }
  finally { await releaseLock(path, opts); }
}
