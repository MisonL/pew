import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueRecord, SessionQueueRecord } from "@pew/core";
import { LocalQueue } from "../storage/local-queue.js";
import { SessionQueue } from "../storage/session-queue.js";
import { isRetiredSource, readIdempotentQueueRows, readIdempotentQueueState } from "../utils/retired-sources.js";
import { tokenRecordKey, readAntigravityBaseline } from "../utils/antigravity-snapshot.js";
import { recoverSyncCommit } from "../storage/sync-commit.js";
import { withStateLock } from "../storage/state-lock.js";

/**
 * Files to delete during reset — pew's own state only.
 * Raw AI tool data (~/.claude/, ~/.gemini/ etc.) is NEVER touched.
 */
const STATE_FILES = [
  "cursors.json",
  "queue.jsonl",
  "queue.state.json",
  "session-cursors.json",
  "session-queue.jsonl",
  "session-queue.state.json",
] as const;

export interface ResetOptions {
  stateDir: string;
  /** Override for testing — defaults to fs.unlink */
  unlinkFn?: typeof unlink;
}

interface ResetFileResult {
  file: string;
  deleted: boolean;
  /**
   * True when the file was deliberately kept (a retained backlog and its
   * state). Distinct from `deleted: false` because of ENOENT: reporting a kept
   * file as "not found" told the operator the opposite of what happened.
   */
  kept?: boolean;
  /**
   * True when the file was removed and then rewritten with nothing but the
   * recorded upload target. Reported separately so the CLI does not claim a
   * file is gone while it sits on disk.
   */
  recreated?: boolean;
}

export interface ResetResult {
  files: ResetFileResult[];
}

/**
 * Delete all pew sync/upload state files so the next `pew sync`
 * performs a clean full scan.
 */
export async function executeReset(opts: ResetOptions): Promise<ResetResult> {
  return withStateLock(opts.stateDir, () => resetLocked(opts));
}

async function resetLocked(opts: ResetOptions): Promise<ResetResult> {
  await recoverSyncCommit(opts.stateDir);
  const unlinkFn = opts.unlinkFn ?? unlink;
  const files: ResetFileResult[] = [];
  const tokens = await readAntigravityBaseline(opts.stateDir, true, { tolerant: true });
  let sessions: SessionQueueRecord[] = [];
  let sessionOffset = 0;
  {
    // Lenient on purpose: a torn tail line from a crashed append is exactly the
    // damage this command exists to repair, so it must not refuse to run.
    const rows = (await readIdempotentQueueRows<SessionQueueRecord>(opts.stateDir, "session-queue.jsonl"))
      .filter((r) => r && typeof r === "object");
    sessions = rows.filter((r) => typeof r.source === "string" && isRetiredSource(r.source) &&
      typeof r.session_key === "string" && !!r.session_key &&
      [r.started_at, r.last_message_at, r.snapshot_at].every((t) => typeof t === "string" && Number.isFinite(Date.parse(t))) &&
      [r.duration_seconds, r.user_messages, r.assistant_messages, r.total_messages].every((n) => Number.isSafeInteger(n) && n >= 0));
    if (sessions.length) {
      const state = await readIdempotentQueueState(opts.stateDir, "session-queue.state.json");
      let offset = 0;
      for (const line of (await readFile(join(opts.stateDir, "session-queue.jsonl"), "utf8")).split("\n")) {
        offset += Buffer.byteLength(line) + 1;
        if (!line || offset > state.offset) continue;
        try {
          if (isRetiredSource((JSON.parse(line) as SessionQueueRecord).source)) {
            sessionOffset += Buffer.byteLength(`${JSON.stringify(JSON.parse(line))}\n`);
          }
        } catch { /* torn line: not a retained record */ }
      }
    }
  }
  const keep = new Set<string>();
  const preserved: Array<() => Promise<void>> = [];
  for (const [queue, records, recordKey, names] of [
    [new LocalQueue(opts.stateDir), tokens, tokenRecordKey, ["queue.jsonl", "queue.state.json"]],
    [new SessionQueue(opts.stateDir), sessions, (r: SessionQueueRecord) => r.session_key, ["session-queue.jsonl", "session-queue.state.json"]],
  ] as const) {
    if (!records.length) continue;
    const state = await readIdempotentQueueState(opts.stateDir, names[1]);
    const pending = state.dirtyKeys ?? (await queue.readFromOffset(state.offset)).records.map((r) =>
      "session_key" in r ? r.session_key : tokenRecordKey(r));
    const keys = new Set(records.map((r) => recordKey(r as QueueRecord & SessionQueueRecord)));
    // Carry lastUploadTarget through the rebuild: reset keeps the retained
    // backlog pending, so the next sync must still be able to warn when it
    // goes to a different host than the last drain.
    const saved = { offset: 0, lastUploadTarget: state.lastUploadTarget };
    preserved.push(async () => {
      await queue.saveState(names[0] === "session-queue.jsonl" ? saved
        : { ...saved, dirtyKeys: pending.filter((key) => keys.has(key)) });
      await queue.overwrite(records as QueueRecord[] & SessionQueueRecord[]);
      if (names[0] === "session-queue.jsonl") await queue.saveState({ ...saved, offset: sessionOffset });
    });
    for (const name of names) keep.add(name);
  }
  const cursorNames = ["cursors.json", "session-cursors.json"];
  // A queue state file this reset would DELETE still carries the recorded
  // upload target, and a full reset makes the next sync replay everything
  // through the queue — the run where a wrong host sends all history at once.
  // Read the target before unlinking and restore it afterwards.
  const restoreTargets = new Map<string, string>();
  for (const name of ["queue.state.json", "session-queue.state.json"]) {
    if (keep.has(name)) continue;
    const retained = await readIdempotentQueueState(opts.stateDir, name);
    if (retained?.lastUploadTarget) restoreTargets.set(name, retained.lastUploadTarget);
  }
  for (const name of [...cursorNames, ...STATE_FILES.filter((n) => !cursorNames.includes(n))]) {
    if (keep.has(name)) { files.push({ file: name, deleted: false, kept: true }); continue; }
    const path = join(opts.stateDir, name);
    try {
      await unlinkFn(path);
      files.push({ file: name, deleted: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        files.push({ file: name, deleted: false });
      } else {
        throw err;
      }
    }
  }
  for (const persist of preserved) await persist();
  // Rebuilt after the unlinks on purpose: offset 0 with no dirtyKeys is what
  // every reader already treats as "nothing uploaded yet".
  for (const [name, target] of restoreTargets) {
    const path = join(opts.stateDir, name);
    await writeFile(`${path}.tmp`, `${JSON.stringify({ offset: 0, lastUploadTarget: target })}\n`, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    const entry = files.find((f) => f.file === name);
    if (entry) entry.recreated = true;
  }

  return { files: files.sort((a, b) => STATE_FILES.indexOf(a.file as typeof STATE_FILES[number]) - STATE_FILES.indexOf(b.file as typeof STATE_FILES[number])) };
}
