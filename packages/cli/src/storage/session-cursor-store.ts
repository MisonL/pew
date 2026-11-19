import { join } from "node:path";
import type { SessionCursorState, SessionFileCursor } from "@pew/core";
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

/** Rebuild a trusted SessionCursorState, or null when the file cannot be one. */
function reviveSessionCursorState(state: Record<string, unknown>): SessionCursorState | null {
  if (!isRecord(state.files)) return null;
  if (state.openCodeSqlite !== undefined && !isRecord(state.openCodeSqlite)) return null;
  if (state.updatedAt !== undefined && state.updatedAt !== null && typeof state.updatedAt !== "string") return null;
  if (state.version !== undefined && state.version !== 1) return null;
  const files = Object.fromEntries(
    Object.entries(state.files).filter((entry): entry is [string, SessionFileCursor] => isSessionFileCursor(entry[1])),
  );
  return { ...state, version: 1, files, updatedAt: (state.updatedAt as string | null | undefined) ?? null } as SessionCursorState;
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
