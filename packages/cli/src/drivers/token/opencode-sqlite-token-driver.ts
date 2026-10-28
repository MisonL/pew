/**
 * OpenCode SQLite DB token driver.
 *
 * Strategy: Watermark-based query (WHERE time_created >= ?).
 * Manages its own DB handle lifecycle.
 * Reads ctx.messageKeys for cross-source dedup with OpenCode JSON.
 *
 * This driver requires a factory function (openMessageDb) to be provided
 * via constructor options, since the native SQLite module is not always available.
 */

import { stat } from "node:fs/promises";
import type { OpenCodeSqliteCursor } from "@pew/core";
import { processOpenCodeMessages } from "../../parsers/opencode-sqlite.js";
import type { QueryMessagesFn } from "../../parsers/opencode-sqlite.js";
import type { DbTokenDriver, DbTokenResult, SyncContext } from "../types.js";

/**
 * Upper bound on re-read ids carried in the cursor. OpenCode writes
 * `time.completed` from a cleanup block that runs even on abort, so a row
 * stays pending only while its generation is still in flight or after a hard
 * crash mid-generation — and a crashed row has no tokens to recover, so
 * dropping the oldest ids costs nothing. The cap keeps a pathological install
 * from growing the cursor without bound.
 */
const MAX_PENDING_IDS = 256;

/** Options needed to construct the SQLite token driver */
export interface OpenCodeSqliteTokenDriverOpts {
  /** Path to the OpenCode SQLite database */
  dbPath: string;
  /** Factory for opening the DB (DI for testability — native SQLite not always available) */
  openMessageDb: (dbPath: string) => { queryMessages: QueryMessagesFn; close: () => void } | null;
}

export function createOpenCodeSqliteTokenDriver(
  opts: OpenCodeSqliteTokenDriverOpts,
): DbTokenDriver<OpenCodeSqliteCursor> {
  return {
    kind: "db",
    source: "opencode",

    async run(
      prevCursor: OpenCodeSqliteCursor | undefined,
      ctx: SyncContext,
    ): Promise<DbTokenResult<OpenCodeSqliteCursor>> {
      // Check if DB file exists
      const dbStat = await stat(opts.dbPath).catch(() => null);
      if (!dbStat) {
        return {
          deltas: [],
          cursor: prevCursor ?? {
            lastTimeCreated: 0,
            lastProcessedIds: [],
            lastSessionUpdated: 0,
            inode: 0,
            updatedAt: new Date().toISOString(),
          },
          rowCount: 0,
        };
      }

      const dbInode = dbStat.ino;

      // If inode changed (DB recreated), reset cursor
      const lastTimeCreated =
        prevCursor && prevCursor.inode === dbInode
          ? prevCursor.lastTimeCreated
          : 0;
      const prevProcessedIds = new Set(
        prevCursor && prevCursor.inode === dbInode
          ? (prevCursor.lastProcessedIds ?? [])
          : [],
      );

      const prevPendingIds =
        prevCursor && prevCursor.inode === dbInode
          ? (prevCursor.pendingIds ?? [])
          : [];

      const handle = opts.openMessageDb(opts.dbPath);
      if (!handle) {
        return {
          deltas: [],
          cursor: prevCursor ?? {
            lastTimeCreated: 0,
            lastProcessedIds: [],
            pendingIds: [],
            lastSessionUpdated: 0,
            inode: dbInode,
            updatedAt: new Date().toISOString(),
          },
          rowCount: 0,
        };
      }

      try {
        // Query uses >= to avoid missing same-millisecond rows, and re-reads
        // every pending id by name: those rows carry no tokens yet, and their
        // time_created sits below the watermark once it advances.
        // We dedup previously-processed IDs from the prior batch.
        const rawRows = handle.queryMessages(lastTimeCreated, prevPendingIds);
        const rows = prevProcessedIds.size > 0
          ? rawRows.filter((r) => !prevProcessedIds.has(r.id))
          : rawRows;

        // Read messageKeys from context for cross-source dedup.
        // During the overlap window, both JSON and SQLite sources contain
        // the same messages. We skip any SQLite row whose messageKey is
        // already tracked by a JSON file cursor.
        const jsonMessageKeys = ctx.messageKeys ?? new Set<string>();

        const filteredRows = rows.filter((row) => {
          if (row.role !== "assistant") return true;
          const key = `${row.session_id}|${row.id}`;
          return !jsonMessageKeys.has(key);
        });

        const result = processOpenCodeMessages(filteredRows, ...(ctx.collectAccounting ? [true] as const : []));

        // Update cursor — advance past ALL rows (including deduped), but keep
        // the rows we held back pending out of the processed set so the next
        // run still lets them through the `>=` boundary filter.
        // Pending re-reads can sit below the watermark, so never let the
        // watermark regress: a lower value would re-scan rows already counted.
        const maxTime = Math.max(
          lastTimeCreated,
          ...rawRows.map((r) => r.time_created),
        );
        const pendingSet = new Set(result.pendingIds);
        const idsAtMax = rawRows
          .filter((r) => r.time_created === maxTime && !pendingSet.has(r.id))
          .map((r) => r.id);

        return {
          deltas: result.deltas,
          cursor: {
            lastTimeCreated: maxTime,
            lastProcessedIds: idsAtMax,
            pendingIds: result.pendingIds.slice(-MAX_PENDING_IDS),
            lastSessionUpdated: prevCursor?.lastSessionUpdated ?? 0,
            inode: dbInode,
            updatedAt: new Date().toISOString(),
          },
          rowCount: rawRows.length,
        };
      } finally {
        handle.close();
      }
    },
  };
}
