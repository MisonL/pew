import { describe, it, expect } from "vitest";
import { createKvAdapter } from "./kv-adapter";
import type { D1Like, D1Result, D1StatementLike } from "./d1-adapter";

interface Row {
  key: string;
  value: string;
  expires_at: string | null;
}

/**
 * In-memory D1Like double that interprets the four SQL shapes kv-adapter
 * issues. It deliberately evaluates expiry itself so the TTL tests exercise
 * the adapter's contract rather than the fake's leniency.
 */
function makeFakeDb() {
  const rows = new Map<string, Row>();

  const live = (row: Row, stamp: string) =>
    row.expires_at === null || row.expires_at > stamp;

  const db: D1Like = {
    prepare(sql: string): D1StatementLike {
      let params: unknown[] = [];
      const stmt: D1StatementLike = {
        sql,
        get params() {
          return params;
        },
        bind: (...next: unknown[]) => {
          params = next;
          return stmt;
        },
        all: async <T,>(): Promise<D1Result<T>> => {
          if (sql.includes("SELECT key FROM kv_cache")) {
            // Byte-exact prefix range: bind order is
            // (prefix, prefix+"￿", prefix, after, stamp, limit).
            const [prefix, upper, gate, after, stamp, limit] = params as
              [string, string, string, string, string, number];
            const matched = [...rows.values()]
              .filter((r) => r.key >= prefix && (gate === "" || r.key < upper) && r.key > after && live(r, stamp))
              // SQLite's TEXT PRIMARY KEY is BINARY collation; localeCompare
              // would order case differently and hide the LIKE-folding bug.
              .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
              .slice(0, limit)
              .map((r) => ({ key: r.key }) as unknown as T);
            return { success: true, results: matched, meta: { changes: 0, duration: 0 } };
          }
          return { success: true, results: [], meta: { changes: 0, duration: 0 } };
        },
        first: async <T,>(): Promise<T | null> => {
          const [key, stamp] = params as [string, string];
          const row = rows.get(key);
          if (!row || !live(row, stamp)) return null;
          return { value: row.value } as unknown as T;
        },
        strong: async <T,>(): Promise<D1Result<T>> => {
          const [key, stamp] = params as [string, string];
          const row = rows.get(key);
          if (!row || !live(row, stamp)) return { success: true, results: [], meta: { changes: 0, duration: 0 } };
          return { success: true, results: [{ value: row.value } as unknown as T], meta: { changes: 0, duration: 0 } };
        },
        run: async (): Promise<D1Result> => {
          if (sql.startsWith("INSERT INTO kv_cache")) {
            const [key, value, expiresAt] = params as [string, string, string | null];
            rows.set(key, { key, value, expires_at: expiresAt });
            return { success: true, results: [], meta: { changes: 1, duration: 0 } };
          }
          if (sql.includes("expires_at IS NOT NULL AND expires_at <=")) {
            // sweepExpired: delete every row whose expiry has passed.
            const stamp = params[0] as string;
            let removed = 0;
            for (const [key, row] of rows) {
              if (row.expires_at !== null && row.expires_at <= stamp) { rows.delete(key); removed += 1; }
            }
            return { success: true, results: [], meta: { changes: removed, duration: 0 } };
          }
          if (sql.startsWith("DELETE FROM kv_cache")) {
            const existed = rows.delete(params[0] as string);
            return { success: true, results: [], meta: { changes: existed ? 1 : 0, duration: 0 } };
          }
          return { success: true, results: [], meta: { changes: 0, duration: 0 } };
        },
      };
      return stmt;
    },
    batch: async () => [],
  };
  return { db, rows };
}

const NOW = 1_700_000_000_000;

describe("kv-adapter", () => {
  it("round-trips a JSON value with get(key, 'json')", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", JSON.stringify({ a: 1 }));
    expect(await kv.get("k", "json")).toEqual({ a: 1 });
  });

  it("returns raw text for get(key, 'text')", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", JSON.stringify({ a: 1 }));
    expect(await kv.get("k", "text")).toBe('{"a":1}');
  });

  it("returns null for a missing key", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    expect(await kv.get("missing", "json")).toBeNull();
  });

  it("honours expirationTtl by filtering expired rows on read", async () => {
    const { db } = makeFakeDb();
    let clock = NOW;
    const kv = createKvAdapter({ db, now: () => clock });
    await kv.put("k", '"v"', { expirationTtl: 60 });
    expect(await kv.get("k", "json")).toBe("v");
    clock += 61_000;
    expect(await kv.get("k", "json")).toBeNull();
  });

  it("treats a row without expires_at as non-expiring", async () => {
    const { db } = makeFakeDb();
    let clock = NOW;
    const kv = createKvAdapter({ db, now: () => clock });
    await kv.put("k", '"v"');
    clock += 10_000_000;
    expect(await kv.get("k", "json")).toBe("v");
  });

  it("treats a non-positive expirationTtl as non-expiring", async () => {
    // Cloudflare KV rejects expirationTtl <= 0; the adapter maps those to a
    // NULL expires_at (never expires) rather than an already-expired row.
    const { db } = makeFakeDb();
    let clock = NOW;
    const kv = createKvAdapter({ db, now: () => clock });
    await kv.put("zero", '"v"', { expirationTtl: 0 });
    await kv.put("neg", '"v"', { expirationTtl: -30 });
    clock += 10_000_000;
    expect(await kv.get("zero", "json")).toBe("v");
    expect(await kv.get("neg", "json")).toBe("v");
  });

  it("delete removes the key", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", '"v"');
    await kv.delete("k");
    expect(await kv.get("k", "json")).toBeNull();
  });

  it("list matches the prefix byte-exactly, not case-insensitively", async () => {
    // SQLite's LIKE folds ASCII case, so the old `key LIKE 'lb:%'` predicate
    // also matched `LB:` and clearAllCache("lb:") would delete keys outside
    // the requested prefix. Cloudflare KV compares bytes.
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("lb:1", "1");
    await kv.put("LB:2", "2");
    await kv.put("lbz:3", "3");
    const page = await kv.list({ prefix: "lb:" });
    expect(page.keys.map((k) => k.name)).toEqual(["lb:1"]);
  });

  it("list treats a prefix containing % or _ literally", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("a%b:1", "1");
    await kv.put("axb:2", "2");
    await kv.put("a_b:3", "3");
    await kv.put("aXb:4", "4");
    expect((await kv.list({ prefix: "a%b:" })).keys.map((k) => k.name)).toEqual(["a%b:1"]);
    expect((await kv.list({ prefix: "a_b:" })).keys.map((k) => k.name)).toEqual(["a_b:3"]);
  });

  it("list returns list_complete true when all keys fit", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("p:a", "1");
    await kv.put("p:b", "2");
    await kv.put("q:c", "3");
    const page = await kv.list({ prefix: "p:", limit: 1000 });
    expect(page.keys.map((k) => k.name).sort()).toEqual(["p:a", "p:b"]);
    expect(page.list_complete).toBe(true);
  });

  it("list paginates with a cursor and never repeats a page", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    for (const k of ["p:a", "p:b", "p:c"]) await kv.put(k, "1");

    const first = await kv.list({ prefix: "p:", limit: 2 });
    expect(first.keys).toHaveLength(2);
    expect(first.list_complete).toBe(false);
    expect(first.cursor).toBeTruthy();

    const second = await kv.list({ prefix: "p:", limit: 2, cursor: first.cursor });
    expect(second.list_complete).toBe(true);
    const names = [...first.keys, ...second.keys].map((k) => k.name);
    expect(new Set(names).size).toBe(3);
  });

  it("list survives delete-while-listing (the clearAllCache loop)", async () => {
    // cache.ts:152-186 deletes each page before asking for the next one. With
    // an OFFSET cursor that loses one page per page (verified: 10 keys, page
    // size 3, 4 keys silently left behind). Keyset cursors must delete all 10.
    const { db, rows } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    for (let i = 0; i < 10; i++) await kv.put(`p:${String(i).padStart(2, "0")}`, "1");

    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await kv.list({ prefix: "p:", limit: 3, cursor });
      for (const k of page.keys) await kv.delete(k.name);
      cursor = page.list_complete ? undefined : page.cursor;
      guard += 1;
      if (guard > 10) throw new Error("cursor did not advance");
    } while (cursor);
    expect(rows.size).toBe(0);
  });

  it("list skips expired entries", async () => {
    const { db } = makeFakeDb();
    let clock = NOW;
    const kv = createKvAdapter({ db, now: () => clock });
    await kv.put("p:a", "1");
    await kv.put("p:b", "2", { expirationTtl: 30 });
    clock += 31_000;
    const page = await kv.list({ prefix: "p:" });
    expect(page.keys.map((k) => k.name)).toEqual(["p:a"]);
  });

  it("get(key, 'json') returns null for malformed JSON instead of throwing", async () => {
    // Cloudflare KV yields null on bad JSON (memory-kv.ts models this); a throw
    // here would diverge from the contract the workers are written against.
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", "not json{");
    expect(await kv.get("k", "json")).toBeNull();
  });

  it("sweepExpired deletes only rows whose TTL has passed", async () => {
    // Cloudflare KV expires entries itself; rqlite does not. Without this the
    // table grows without bound (leaderboard keys embed the revision).
    const { db, rows } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("live", "v", { expirationTtl: 3600 });
    await kv.put("dead", "v", { expirationTtl: 1 });
    await kv.put("forever", "v");
    const later = createKvAdapter({ db, now: () => NOW + 10_000 });
    expect(await later.sweepExpired()).toBe(1);
    expect([...rows.keys()].sort()).toEqual(["forever", "live"]);
  });

  it("list with limit 0 terminates instead of looping forever", async () => {
    // limit 0 previously produced list_complete=false with no cursor, which
    // would spin a caller like clearAllCache forever. Clamped to a page of 1.
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("p:a", "1");
    const page = await kv.list({ prefix: "p:", limit: 0 });
    expect(page.keys.length).toBeLessThanOrEqual(1);
    if (!page.list_complete) expect(page.cursor).toBeTruthy();
  });
});
