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
            // Bind order is (pattern, after, stamp, limit).
            const [pattern, after, stamp, limit] = params as [string, string, string, number];
            const prefix = pattern.replace(/%$/, "").replace(/\\(.)/g, "$1");
            const matched = [...rows.values()]
              .filter((r) => r.key.startsWith(prefix) && r.key > after && live(r, stamp))
              .sort((a, b) => a.key.localeCompare(b.key))
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
        run: async (): Promise<D1Result> => {
          if (sql.startsWith("INSERT INTO kv_cache")) {
            const [key, value, expiresAt] = params as [string, string, string | null];
            rows.set(key, { key, value, expires_at: expiresAt });
            return { success: true, results: [], meta: { changes: 1, duration: 0 } };
          }
          if (sql.startsWith("DELETE FROM kv_cache")) {
            const existed = rows.delete(params[0] as string);
            return { success: true, results: [], meta: { changes: existed ? 1 : 0, duration: 0 } };
          }
          return { success: true, results: [], meta: { changes: 0, duration: 0 } };
        },
        strong: async <T,>(): Promise<D1Result<T>> => ({ success: true, results: [] as T[], meta: { changes: 0, duration: 0 } }),
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

  it("delete removes the key", async () => {
    const { db } = makeFakeDb();
    const kv = createKvAdapter({ db, now: () => NOW });
    await kv.put("k", '"v"');
    await kv.delete("k");
    expect(await kv.get("k", "json")).toBeNull();
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
