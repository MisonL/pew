import { stat } from "node:fs/promises";
import type { Source } from "@pew/core";
import type { ParsedDelta } from "./claude.js";
import { normalizeOpenCodeTokens, openCodeAccounting } from "./opencode.js";
import { isAllZero } from "../utils/token-delta.js";
import { coerceEpochMs } from "../utils/time.js";

/** Result of parsing OpenCode SQLite database */
export interface OpenCodeSqliteResult {
  /** Parsed token deltas (one per assistant message) */
  deltas: ParsedDelta[];
  /** Message keys for dedup: "sessionId|messageId" */
  messageKeys: Set<string>;
  /** Highest time_created seen (for cursor advancement) */
  maxTimeCreated: number;
  /**
   * Assistant messages seen without `time.completed`. OpenCode inserts the
   * row before the model call and writes tokens at step-finish, so their
   * values are not final yet; the driver re-reads these ids on the next run.
   */
  pendingIds: string[];
  /** DB file inode (for detecting replacement/recreation) */
  inode: number;
}

/** Row shape from the message table */
export interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  /** Extracted via json_extract(data, '$.role') at the SQL level */
  role: string | null;
  data: string;
}

/**
 * How long a message without `time.completed` is treated as still generating.
 *
 * OpenCode writes `time.completed` from a cleanup block that runs on normal
 * completion, on interrupt and on error, so a row that stays unmarked is one
 * whose process died mid-generation. Past this bound the row is read with
 * whatever it holds instead of being held back forever — which also keeps a
 * future OpenCode release that stops writing the field from silently zeroing
 * this source's usage.
 */
const STALE_GENERATION_MS = 6 * 60 * 60 * 1000;

/**
 * Function that queries the message table.
 * Accepts lastTimeCreated and returns rows where time_created >= lastTimeCreated,
 * plus any rows whose id appears in pendingIds (messages observed before their
 * tokens were written — see OpenCodeSqliteResult.pendingIds).
 * Callers must filter out previously-processed IDs from the prior batch
 * to handle same-millisecond boundary dedup.
 */
export type QueryMessagesFn = (
  lastTimeCreated: number,
  pendingIds?: readonly string[],
) => MessageRow[];

/**
 * Parse message rows from OpenCode's SQLite database for token usage records.
 *
 * Processes rows from the `message` table where `time_created > lastTimeCreated`.
 *
 * Unlike the JSON file parser, no diffTotals is needed — each SQLite row
 * is an independent message with absolute token values.
 *
 * An assistant row with all-zero tokens and no `time.completed` is an in-flight
 * message: OpenCode inserts the row before the model call and writes tokens at
 * step-finish, without touching `time_created`. Emitting it here would record
 * nothing and — because the cursor then advances past its `time_created` —
 * lose the message's usage for good. Those ids come back as `pendingIds` so the
 * driver re-reads them until they settle. Rows that already carry tokens are
 * emitted as before, so a version that never writes `time.completed` still
 * reports its usage.
 *
 * The `queryMessages` function is injected to decouple from the native SQLite module
 * for testability. Use `openMessageDb()` from `opencode-sqlite-db.ts` to
 * create the real adapter at runtime.
 */
export function processOpenCodeMessages(
  rows: MessageRow[],
  includeAccounting = false,
  nowMs = Date.now(),
): Omit<OpenCodeSqliteResult, "inode"> {
  const deltas: ParsedDelta[] = [];
  const messageKeys = new Set<string>();
  const pendingIds: string[] = [];
  let maxTimeCreated = 0;

  for (const row of rows) {
    // Track max time_created for cursor
    if (row.time_created > maxTimeCreated) {
      maxTimeCreated = row.time_created;
    }

    // Only process assistant messages (role is pre-extracted at SQL level)
    if (row.role !== "assistant") continue;

    // Parse data JSON
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(row.data);
    } catch {
      continue;
    }

    // Build message key for dedup
    messageKeys.add(`${row.session_id}|${row.id}`);

    // Normalize tokens
    const tokens = normalizeOpenCodeTokens(
      msg.tokens as Record<string, unknown> | null,
    );

    const time = msg.time as Record<string, unknown> | undefined;
    const completedMs = coerceEpochMs(time?.completed);
    const createdMs = coerceEpochMs(time?.created);

    // OpenCode inserts the row with `time.created` before the model call, then
    // rewrites `tokens` at step-finish and sets `time.completed` once the
    // message is done (cleanup runs on success, interrupt and error), without
    // ever moving `time_created`. Reading it early would record zero or
    // partial usage and — because the cursor advances past `time_created` —
    // never look at the row again. Hold back until completed.
    // The age bound keeps a row whose writer died from lingering pending
    // forever: it is read with whatever it holds instead.
    const stale = createdMs > 0 && nowMs - createdMs > STALE_GENERATION_MS;
    if (!completedMs && createdMs > 0 && !stale) {
      pendingIds.push(row.id);
      continue;
    }

    if (!tokens || isAllZero(tokens)) continue;

    // Extract timestamp from time.completed or time.created
    const timestampMs = completedMs || createdMs;
    if (!timestampMs) continue;

    // Extract model
    const model =
      typeof msg.modelID === "string"
        ? msg.modelID.trim()
        : typeof msg.model === "string"
          ? (msg.model as string).trim()
          : "unknown";

    deltas.push({
      source: "opencode" as Source,
      model,
      timestamp: new Date(timestampMs).toISOString(),
      tokens,
      ...(includeAccounting ? { accounting: openCodeAccounting(tokens, msg, model) } : {}),
    });
  }

  return { deltas, messageKeys, maxTimeCreated, pendingIds };
}

/**
 * High-level entry: parse OpenCode SQLite database for token usage.
 *
 * Opens the database, queries new messages, and returns parsed deltas.
 * The `queryMessages` function provides the database access layer.
 */
export async function parseOpenCodeSqlite(opts: {
  dbPath: string;
  lastTimeCreated: number;
  pendingIds?: readonly string[];
  queryMessages?: QueryMessagesFn;
  includeAccounting?: boolean;
}): Promise<OpenCodeSqliteResult> {
  const { dbPath, lastTimeCreated, queryMessages } = opts;

  const empty: OpenCodeSqliteResult = {
    deltas: [],
    messageKeys: new Set(),
    maxTimeCreated: 0,
    pendingIds: [],
    inode: 0,
  };

  // Check if database file exists and get inode
  let fileInode: number;
  try {
    const st = await stat(dbPath);
    fileInode = st.ino;
  } catch {
    return empty;
  }

  if (!queryMessages) {
    return empty;
  }

  let rows: MessageRow[];
  try {
    rows = queryMessages(lastTimeCreated, opts.pendingIds ?? []);
  } catch {
    return empty;
  }

  const result = processOpenCodeMessages(rows, opts.includeAccounting);
  return { ...result, inode: fileInode };
}
