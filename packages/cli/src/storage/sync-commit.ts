import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountingRecord, CursorState, EvidenceRecord, QueueRecord, Source } from "@pew/core";
import { AccountingQueue, checkedRecord as checkedAccounting } from "./accounting-queue.js";
import { EvidenceQueue, checkedRecord as checkedEvidence } from "./evidence-queue.js";
import { LocalQueue } from "./local-queue.js";
import { CursorStore, reviveCursorState } from "./cursor-store.js";
import { ensureSecureDir } from "./secure-mkdir.js";
import { isRecord } from "./state-shape.js";

interface SyncCommit {
  version: 1;
  records?: QueueRecord[];
  dirtyKeys?: string[];
  evidence: EvidenceRecord[];
  accounting: AccountingRecord[];
  replay: boolean;
  preserveAccountingSources?: Source[];
  cursors: CursorState;
}

const INVALID = "Invalid pending sync commit; preserve Pew state for recovery";

/**
 * A row the queue writer can serialize.
 *
 * Deliberately just "an object": the queue legitimately carries rows this
 * build cannot interpret — a stale row from an older version that
 * `aggregateRecords` passes through unchanged, a retired source, a source a
 * newer CLI knows about — and the upload stage, not recovery, is what filters
 * those. Recovery must not turn such a queue into an unrecoverable journal; it
 * only has to refuse values the JSONL format cannot hold at all.
 */
function isQueueRowShaped(value: unknown): boolean {
  return isRecord(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Everything `recoverSyncCommit` is about to write, checked before the first
 * write.
 *
 * The journal is the recovery boundary: a damaged one has to fail as a unit.
 * Before this, `records: { a: 1 }` reached `overwrite()` (no `.length`, so it
 * wrote an empty file) and `cursors: "garbage"` was saved verbatim and the
 * journal deleted — the next sync then read a nonsense cursor file instead of
 * a recoverable journal. Checking only inside the merge loops was not enough
 * either: a valid evidence batch merged (ledger written) before a damaged
 * accounting batch threw, leaving the journal to replay a batch that was
 * already durable.
 *
 * Cursors go through the store's own `reviveCursorState`, so the journal is
 * held to exactly the contract a cursors.json load would apply; a repaired
 * state (a dropped per-file entry, kept in `knownFilePaths` so it rescans) is
 * still accepted, because that is the documented recovery.
 */
function readCommit(raw: string): SyncCommit {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(INVALID); }
  if (!isRecord(parsed)) throw new Error(INVALID);
  const { version, records, dirtyKeys, evidence, accounting, replay, preserveAccountingSources, cursors } = parsed;
  if (version !== 1) throw new Error(INVALID);
  if (typeof replay !== "boolean") throw new Error(INVALID);
  if (records !== undefined && (!Array.isArray(records) || !records.every(isQueueRowShaped))) throw new Error(INVALID);
  if (dirtyKeys !== undefined && !isStringArray(dirtyKeys)) throw new Error(INVALID);
  if (preserveAccountingSources !== undefined && !isStringArray(preserveAccountingSources)) throw new Error(INVALID);
  if (!isRecord(cursors)) throw new Error(INVALID);
  const revivedCursors = reviveCursorState(cursors);
  if (!revivedCursors) throw new Error(INVALID);
  if (!Array.isArray(evidence)) throw new Error(INVALID);
  if (!Array.isArray(accounting)) throw new Error(INVALID);
  // The ledgers' own validators, run here rather than inside their merges so
  // every payload is rejected before any ledger, queue or cursor is touched.
  try {
    for (const record of evidence) checkedEvidence(record);
    for (const record of accounting) checkedAccounting(record);
  } catch { throw new Error(INVALID); }
  return { version: 1, records: records as QueueRecord[] | undefined, dirtyKeys: dirtyKeys as string[] | undefined,
    evidence: evidence as EvidenceRecord[], accounting: accounting as AccountingRecord[], replay,
    preserveAccountingSources: preserveAccountingSources as Source[] | undefined, cursors: revivedCursors };
}

/** Recover absolute writes BEFORE reading a source cursor or uploading any queue. */
export async function recoverSyncCommit(
  stateDir: string,
  onWarning?: (message: string) => void,
  /**
   * `commitSync` replays the journal it just wrote; quarantining there would
   * report success for a commit that applied nothing, so it disables this.
   * Startup recovery quarantines: otherwise one damaged journal makes every
   * sync/upload/reset fail forever until an operator hand-deletes the file.
   */
  opts: { quarantineInvalidJournal?: boolean } = {},
): Promise<void> {
  const path = join(stateDir, "sync-commit.json");
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let commit: SyncCommit;
  try {
    commit = readCommit(raw);
  } catch (error) {
    if (opts.quarantineInvalidJournal === false || !(error instanceof Error) || error.message !== INVALID) throw error;
    // Keep the damaged file for inspection, but under a name no recovery path
    // reads, so the commands that follow can make progress. Its staged writes
    // are skipped — the next sync re-reads the same raw bytes from the
    // still-unchanged cursors and rebuilds them, the same recovery a crash
    // before the journal was staged gets.
    const quarantinePath = join(stateDir, `sync-commit.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await rename(path, quarantinePath);
    onWarning?.(
      `A damaged sync-commit journal was moved to ${quarantinePath.slice(stateDir.length + 1)} and its staged changes were skipped; ` +
      "the next sync re-reads the source logs. If totals look incomplete afterwards, run `pew reset && pew sync`.",
    );
    return;
  }
  await new EvidenceQueue(stateDir).merge(commit.evidence, commit.replay, onWarning);
  await new AccountingQueue(stateDir).merge(commit.accounting, commit.replay, commit.preserveAccountingSources, onWarning);
  if (commit.records) {
    const queue = new LocalQueue(stateDir);
    await queue.saveDirtyKeys(commit.dirtyKeys ?? []);
    await queue.overwrite(commit.records);
    await queue.saveOffset(0);
  }
  await new CursorStore(stateDir).save(commit.cursors);
  await unlink(path);
}

/**
 * Whether a commit is in flight: its staged temp file or its journal. The
 * journal is DELETED by a successful commit, so "no journal" alone is
 * ambiguous; a staged temp means the queue write it guards is under way.
 */
export async function syncCommitPending(stateDir: string): Promise<boolean> {
  for (const name of ["sync-commit.json.tmp", "sync-commit.json"]) {
    try {
      await access(join(stateDir, name));
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** The single journal makes queue/detail/cursor replacement retryable after any partial write. */
export async function commitSync(stateDir: string, commit: SyncCommit, onWarning?: (message: string) => void): Promise<void> {
  await ensureSecureDir(stateDir, { recursive: true });
  const path = join(stateDir, "sync-commit.json");
  await writeFile(`${path}.tmp`, JSON.stringify(commit), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  // Quarantine disabled here: this journal was staged milliseconds ago by the
  // caller who needs its writes applied. Silently skipping them would report
  // a successful sync that applied nothing. If it fails validation, the throw
  // surfaces to the caller; the leftover file is quarantined on the next
  // command's startup recovery.
  await recoverSyncCommit(stateDir, onWarning, { quarantineInvalidJournal: false });
}
