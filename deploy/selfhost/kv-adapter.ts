/**
 * Cloudflare KV namespace shape over the rqlite-backed D1 adapter.
 *
 * Only the operations worker-read actually performs are implemented:
 *   get(key, "json" | "text")   cache.ts, sync/kv-store.ts, leaderboard-snapshot.ts
 *   put(key, value, {expirationTtl})   three call sites rely on the TTL
 *   delete(key)                 cache.ts:164,195
 *   list({prefix, limit, cursor})  cache.ts pagination loops
 *
 * getWithMetadata, arrayBuffer and stream are unused by worker-read.
 */

import type { D1Like } from "./d1-adapter";

export interface KVListResult {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

export interface KVLike {
  get(key: string, type?: "text" | "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVListResult>;
}

/** Selfhost-only extension: Cloudflare KV expires rows itself, rqlite does not. */
export interface KvAdapter extends KVLike {
  /** Delete rows whose expiry has passed. Returns the number removed. */
  sweepExpired(): Promise<number>;
}

export interface KvAdapterOptions {
  db: D1Like;
  now?: () => number;
}

const SELECT_SQL =
  "SELECT value, expires_at FROM kv_cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)";
const UPSERT_SQL =
  "INSERT INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at";
const DELETE_SQL = "DELETE FROM kv_cache WHERE key = ?";
// Cloudflare KV drops expired entries on its own; rqlite keeps them forever.
// leaderboard snapshot keys embed the revision (`lb:v1:<revision>:<key>`), so
// every data change mints a fresh key and the old ones become permanent dead
// rows — storage, raft log and backup growth with no upper bound. The
// scheduler calls sweepExpired() daily; idx_kv_cache_expires (migration 031)
// makes it a range scan.
const SWEEP_SQL = "DELETE FROM kv_cache WHERE expires_at IS NOT NULL AND expires_at <= ?";

export function createKvAdapter(options: KvAdapterOptions): KvAdapter {
  const { db } = options;
  const now = options.now ?? (() => Date.now());

  /** Cursors carry the last key of the previous page (keyset, not offset). */
  function parseCursor(cursor: string | undefined): string {
    if (!cursor) return "";
    return cursor;
  }

  return {
    async get(key: string, type: "text" | "json" = "text"): Promise<unknown> {
      const stamp = new Date(now()).toISOString();
      // strong read: cache.invalidate()/clear() must be visible to the next
      // get() even when a cluster follower lags (read-after-write contract
      // the worker's cache layer assumes; the migration ledger documents the
      // extra leader round-trip as accepted for exactly this path).
      const result = await db.prepare(SELECT_SQL).bind(key, stamp).strong<{ value: string }>();
      const row = result.results[0] ?? null;
      if (!row) return null;
      if (type === "json") {
        // Mirror Cloudflare KV: malformed JSON yields null, not a throw. The
        // callers already guard (cache.ts:62 wraps in try/catch; kv-store.ts:46
        // maps to null), but the adapter should match the contract directly.
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      }
      return row.value;
    },

    async put(key: string, value: string, putOptions?: { expirationTtl?: number }): Promise<void> {
      const ttl = putOptions?.expirationTtl;
      const expiresAt =
        typeof ttl === "number" && ttl > 0
          ? new Date(now() + ttl * 1000).toISOString()
          : null;
      await db.prepare(UPSERT_SQL).bind(key, value, expiresAt).run();
    },

    async delete(key: string): Promise<void> {
      await db.prepare(DELETE_SQL).bind(key).run();
    },

    async sweepExpired(): Promise<number> {
      const stamp = new Date(now()).toISOString();
      const { meta } = await db.prepare(SWEEP_SQL).bind(stamp).run();
      return meta.changes ?? 0;
    },

    async list(listOptions?: {
      prefix?: string;
      limit?: number;
      cursor?: string;
    }): Promise<KVListResult> {
      const prefix = listOptions?.prefix ?? "";
      // Clamp to a positive page size: with limit = 0 the old code computed
      // hasMore = (any rows exist) and returned no cursor, which would make
      // callers like clearAllCache loop forever on an empty page.
      const limit = Math.max(1, listOptions?.limit ?? 1000);
      const after = parseCursor(listOptions?.cursor);
      const stamp = new Date(now()).toISOString();

      // Keyset pagination: the cursor is the last key of the previous page.
      // An OFFSET cursor silently skips keys when the caller deletes as it
      // lists (cache.ts:152-186 clearAllCache does exactly that) — every page
      // of deletions shifts the remaining rows left and the loop loses one
      // page per page (verified: 10 keys, page 3, deleted 6 of 10).
      const { results } = await db
        .prepare(
          "SELECT key FROM kv_cache WHERE key LIKE ? ESCAPE '\\' AND key > ? " +
            "AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?"
        )
        .bind(`${prefix.replace(/[%_\\]/g, "\\$&")}%`, after, stamp, limit + 1)
        .all<{ key: string }>();

      const hasMore = results.length > limit;
      const page = hasMore ? results.slice(0, limit) : results;
      const last = page[page.length - 1];
      return {
        keys: page.map((r) => ({ name: r.key })),
        list_complete: !hasMore,
        ...(hasMore && last ? { cursor: last.key } : {}),
      };
    },
  };
}
