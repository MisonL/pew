import { join } from "node:path";
import type { OpenCodeSqliteSessionCursor, SessionCursorState, SessionFileCursor } from "@pew/core";
import { BaseCursorStore } from "./base-cursor-store.js";
import { isRecord } from "./state-shape.js";

const CURSORS_FILE = "session-cursors.json";

/**
 * A session cursor is mtime-keyed; `size` is optional because OpenCode JSON
 * cursors point at directories, where size is unreliable across filesystems.
 */
function isSessionFileCursor(value: unknown): value is SessionFileCursor {
  return isRecord(value) && typeof value.mtimeMs === "number";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The OpenCode SQLite cursor is fed straight into the driver: lastTimeUpdated
 * becomes a SQL parameter, lastProcessedIds is turned into a Set, inode is
 * compared with the live file. A wrong type there does not degrade — a string
 * watermark makes every `time_updated >= ?` false (TEXT sorts above every
 * integer) and gets written back forever, and a non-iterable id list throws.
 * Either way the source never heals without deleting the state file, so drop
 * the damaged entry and let the next run start from zero (dedup is by
 * session_key, so a rescan cannot double count).
 */
function isOpenCodeSqliteCursor(value: unknown): value is OpenCodeSqliteSessionCursor {
  if (!isRecord(value)) return false;
  if (!isNonNegativeInteger(value.lastTimeUpdated) || !isNonNegativeInteger(value.inode)) return false;
  if (!Array.isArray(value.lastProcessedIds) || !value.lastProcessedIds.every((id) => typeof id === "string")) return false;
  if (value.updatedAt !== undefined && value.updatedAt !== null && typeof value.updatedAt !== "string") return false;
  return true;
}

/** Rebuild a trusted SessionCursorState, or null when the file cannot be one. */
function reviveSessionCursorState(state: Record<string, unknown>): SessionCursorState | null {
  if (!isRecord(state.files)) return null;
  if (state.updatedAt !== undefined && state.updatedAt !== null && typeof state.updatedAt !== "string") return null;
  if (state.version !== undefined && state.version !== 1) return null;
  const files = Object.fromEntries(
    Object.entries(state.files).filter((entry): entry is [string, SessionFileCursor] => isSessionFileCursor(entry[1])),
  );
  const { openCodeSqlite, ...rest } = state;
  return {
    ...rest,
    version: 1,
    files,
    updatedAt: (state.updatedAt as string | null | undefined) ?? null,
    ...(isOpenCodeSqliteCursor(openCodeSqlite) ? { openCodeSqlite } : {}),
  } as SessionCursorState;
}

/**
 * Persists session file cursors (mtime + size dual-check) to disk.
 * Stored at ~/.config/pew/session-cursors.json
 */
export class SessionCursorStore extends BaseCursorStore<SessionCursorState> {
  constructor(storeDir: string) {
    super(join(storeDir, CURSORS_FILE), () => ({ version: 1, files: {}, updatedAt: null }), {
      revive: reviveSessionCursorState,
    });
  }
}
