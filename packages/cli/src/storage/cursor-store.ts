import { join } from "node:path";
import type { CursorState, FileCursor } from "@pew/core";
import { BaseCursorStore } from "./base-cursor-store.js";
import { isRecord } from "./state-shape.js";

const CURSORS_FILE = "cursors.json";

/** Finite number, for values later used in arithmetic or stream offsets. */
function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** null or a string, for values used as map keys / labels. */
function isNullableText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** Array of strings, for id lists that are iterated. */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * A token-total baseline, or null.
 *
 * The Codex/OpenCode/Hermes drivers subtract this from the next cumulative
 * total. A string or missing field turns that subtraction into NaN, and NaN
 * flows into the uploaded record — rejected by the server after the cursor
 * has already moved past the bytes.
 */
function isTokenTotals(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"]
    .every((key) => isFiniteNumber(value[key]));
}

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
  // Resume arithmetic: a non-numeric offset becomes NaN in comparisons and
  // inside createReadStream's start option, and a string offset or size
  // silently skips or replays the file. Byte positions and sizes must also
  // be non-negative integers: a corrupted negative/fractional offset makes
  // the continuity resolver park the file at EOF every round, silently
  // skipping new increments — dropping the entry instead routes recovery
  // through the cursor-loss branch (knownFilePaths → full rescan), which
  // re-reads the file without losing the append window.
  for (const key of ["mtimeMs", "size", "offset", "lastCacheWrite"]) {
    if (value[key] !== undefined && value[key] !== null && !isFiniteNumber(value[key])) return false;
  }
  for (const key of ["size", "offset"]) {
    if (typeof value[key] === "number" && (!Number.isInteger(value[key]) || (value[key] as number) < 0)) return false;
  }
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "string") return false;
  if (value.continuityBroken !== undefined && typeof value.continuityBroken !== "boolean") return false;
  if (value.continuityAnchors !== undefined) {
    if (!Array.isArray(value.continuityAnchors)) return false;
    for (const anchor of value.continuityAnchors) {
      if (!isRecord(anchor) || typeof anchor.sha256 !== "string" || !isFiniteNumber(anchor.length)) return false;
      if (typeof anchor.length === "number" && (!Number.isInteger(anchor.length) || anchor.length < 0)) return false;
    }
  }
  if (!isTokenTotals(value.lastTotals)) return false;
  for (const key of ["lastModel", "messageKey", "scopeId"]) {
    if (!isNullableText(value[key])) return false;
  }
  if (value.accountingContext !== undefined) {
    if (!isRecord(value.accountingContext)) return false;
    for (const key of ["provider", "route", "service_tier"]) {
      if (!isNullableText(value.accountingContext[key])) return false;
    }
  }
  return true;
}

/** SQLite cursor shapes are dereferenced field by field by the DB drivers. */
function isOpenCodeSqliteCursor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.lastTimeCreated) || !isFiniteNumber(value.lastSessionUpdated)) return false;
  if (!isFiniteNumber(value.inode) || typeof value.updatedAt !== "string") return false;
  for (const key of ["pendingIds", "lastProcessedIds"]) {
    if (value[key] !== undefined && !isStringArray(value[key])) return false;
  }
  return true;
}

function isHermesSqliteCursor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.inode) || typeof value.updatedAt !== "string") return false;
  if (!isRecord(value.sessionTotals)) return false;
  for (const totals of Object.values(value.sessionTotals)) {
    if (!isRecord(totals)) return false;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) {
      if (!isFiniteNumber(totals[key])) return false;
    }
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
      if (!isStringArray(scope.usageKeys)) return null;
      if (!isTokenTotals(scope.totals)) return null;
    }
  }
  // Nested shapes the drivers dereference directly. A DB cursor that is a
  // record but carries strings where epochs belong reads as an epoch of NaN,
  // which the incremental query compares against every row: the source either
  // re-reads everything or skips it, permanently. Discard the whole state and
  // take the documented full-rescan recovery.
  if (state.openCodeSqlite !== undefined && !isOpenCodeSqliteCursor(state.openCodeSqlite)) return null;
  if (state.antigravity !== undefined) {
    if (!isRecord(state.antigravity) || !isFiniteNumber(state.antigravity.dbCount) || typeof state.antigravity.updatedAt !== "string") return null;
  }
  if (state.hermesSqlite !== undefined) {
    // A pre-multi-profile cursor is the flat Hermes cursor itself; sync.ts
    // migrates it to { default: cursor } on first access.
    if (!isHermesSqliteCursor(state.hermesSqlite)) {
      for (const cursor of Object.values(state.hermesSqlite as Record<string, unknown>)) {
        if (!isHermesSqliteCursor(cursor)) return null;
      }
    }
  }
  if (state.dirMtimes !== undefined) {
    for (const mtime of Object.values(state.dirMtimes as Record<string, unknown>)) {
      if (!isFiniteNumber(mtime)) return null;
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
