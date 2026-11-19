import { join } from "node:path";
import type { CursorState, FileCursor } from "@pew/core";
import { BaseCursorStore } from "./base-cursor-store.js";
import { isRecord } from "./state-shape.js";

const CURSORS_FILE = "cursors.json";

/** A per-file cursor is an object carrying at least the change fingerprint. */
function isFileCursor(value: unknown): value is FileCursor {
  if (!isRecord(value) || typeof value.inode !== "number") return false;
  // Claude's dedup ring is the only field a driver ITERATES; a non-iterable
  // one ("ids is not iterable") or a non-string entry poisons the per-run Set
  // and takes down every source, not just this file.
  if (value.seenIds !== undefined) {
    if (!Array.isArray(value.seenIds)) return false;
    if (!value.seenIds.every((id) => typeof id === "string")) return false;
  }
  return true;
}

/**
 * Rebuild a trusted CursorState, or null when the file cannot be one.
 *
 * Two different repairs, because the two failures have different safe
 * recoveries:
 *
 * - A single bad per-file entry is DROPPED, not fatal. Its path stays in
 *   `knownFilePaths`, so the sync's cursor-loss check turns it into a
 *   full-rescan restart, which overwrites the queue instead of adding to it.
 *   Keeping the bad entry was worse than dropping it: it read as "changed"
 *   with startOffset 0, so the whole file was re-parsed at offset 0 and SUMmed
 *   onto the pending queue — silently double counting.
 * - A bad optional field (a non-object `hermesSqlite` crashed the migration
 *   check; a missing `files` crashed the scan loop) discards the entire state.
 *   Rebuilding it piecemeal would keep `files` while losing `codexScopes`,
 *   and the cross-rollout high-water marks in there are what stop a shared
 *   cumulative counter from being counted twice.
 */
export function reviveCursorState(state: Record<string, unknown>): CursorState | null {
  if (!isRecord(state.files)) return null;
  for (const field of ["knownFilePaths", "knownDbSources", "dirMtimes", "hermesSqlite", "openCodeSqlite", "antigravity"] as const) {
    if (state[field] !== undefined && !isRecord(state[field])) return null;
  }
  // The scan seeds ctx.codexScopeTotals / codexSeenUsageKeys from this map
  // before reading a single file; a non-iterable `usageKeys` aborted every
  // source, and the entries are also destructured as objects below.
  if (state.codexScopes !== undefined) {
    if (!isRecord(state.codexScopes)) return null;
    for (const scope of Object.values(state.codexScopes)) {
      if (!isRecord(scope) || !Array.isArray(scope.usageKeys)) return null;
    }
  }
  if (state.accountingSchemaVersion !== undefined && typeof state.accountingSchemaVersion !== "number") return null;
  if (state.updatedAt !== undefined && state.updatedAt !== null && typeof state.updatedAt !== "string") return null;
  if (state.version !== undefined && state.version !== 1) return null;

  const files: Record<string, FileCursor> = {};
  const dropped: string[] = [];
  for (const [path, cursor] of Object.entries(state.files)) {
    if (isFileCursor(cursor)) files[path] = cursor;
    else dropped.push(path);
  }
  // Record each dropped path as already scanned so the sync's cursor-loss check
  // turns it into a full-rescan restart instead of reading it as a brand-new
  // file, which would SUM a whole replay onto the pending queue. Only build the
  // map when the file already had one: adding it to a pre-v1.6.0 cursor would
  // suppress the legacy one-time full rescan that its absence triggers.
  const knownFilePaths = isRecord(state.knownFilePaths)
    ? { ...(state.knownFilePaths as Record<string, true>) }
    : undefined;
  for (const path of dropped) {
    if (knownFilePaths) knownFilePaths[path] = true;
  }
  return {
    ...state,
    version: 1,
    files,
    ...(knownFilePaths ? { knownFilePaths } : {}),
    updatedAt: (state.updatedAt as string | null | undefined) ?? null,
  } as CursorState;
}

/**
 * Persists incremental parsing cursors to disk.
 * Stored at ~/.config/pew/cursors.json
 */
export class CursorStore extends BaseCursorStore<CursorState> {
  constructor(storeDir: string) {
    super(join(storeDir, CURSORS_FILE), () => ({ version: 1, files: {}, updatedAt: null }), {
      revive: reviveCursorState,
    });
  }
}
