import { describe, it, expect, vi } from "vitest";
import { createD1Adapter } from "./d1-adapter";

const BASE = "http://rqlite:4001";
const TOKEN = "test-token";

function rqliteResponse(results: unknown[], status = 200) {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve({ results }),
  } as unknown as Response;
}

function makeAdapter(fetchImpl: typeof fetch) {
  return createD1Adapter({ baseUrl: BASE, token: TOKEN, fetchImpl });
}

describe("d1-adapter reads", () => {
  it("sends flat params and associative + weak level", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ types: { a: "integer" }, rows: [{ a: 1 }] }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const res = await db.prepare("SELECT a FROM t WHERE b = ?").bind(7).all();
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/db/query?level=weak&associative&timings`);
    expect(JSON.parse(init.body)).toEqual([["SELECT a FROM t WHERE b = ?", 7]]);
    expect(res.results).toEqual([{ a: 1 }]);
    expect(res.success).toBe(true);
  });

  it("first() returns the first row or null", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rqliteResponse([{ rows: [{ a: 1 }, { a: 2 }] }]))
      .mockResolvedValueOnce(rqliteResponse([{ rows: [] }]));
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    expect(await db.prepare("SELECT a FROM t").first()).toEqual({ a: 1 });
    expect(await db.prepare("SELECT a FROM t").first()).toBeNull();
  });

  it("first(column) extracts that column", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ rows: [{ a: 1, b: 2 }] }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    expect(await db.prepare("SELECT a, b FROM t").first("b")).toBe(2);
  });

  it("supports prepare().run() without bind (4 production call sites do this)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 5, rows_affected: 1 }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const res = await db.prepare("UPDATE t SET a = 1").run();
    expect(res.meta.changes).toBe(1);
    expect(res.meta.last_row_id).toBe(5);
  });

  it("routes run() through /db/request like batch()", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 5, rows_affected: 1 }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await db.prepare("UPDATE t SET a = 1").run();
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toBe(`${BASE}/db/request?transaction=true&associative&timings`);
  });
});

describe("d1-adapter error and edge handling", () => {
  it("throws when rqlite reports an error inside HTTP 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ error: "no such table: nope" }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await expect(db.prepare("SELECT * FROM nope").all()).rejects.toThrow(
      /no such table/
    );
  });

  it("defaults changes to 0 when rows_affected is omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 3 }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const res = await db.prepare("UPDATE t SET a = 1 WHERE 0").run();
    expect(res.meta.changes).toBe(0);
  });

  it("returns [] for an empty batch without calling rqlite", async () => {
    const fetchImpl = vi.fn();
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    expect(await db.batch([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("d1-adapter batch", () => {
  it("uses /db/request with transaction=true and associative", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([
        { rows: [{ k: "a" }] },
        { last_insert_id: 1, rows_affected: 1 },
      ])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await db.batch([db.prepare("SELECT 1"), db.prepare("INSERT INTO t VALUES (1)")]);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/db/request?transaction=true&associative&timings`);
    expect(JSON.parse(init.body)).toEqual([
      ["SELECT 1"],
      ["INSERT INTO t VALUES (1)"],
    ]);
  });

  it("preserves rows from a plain SELECT mixed into a write batch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([
        { rows: [{ k: "a" }, { k: "b" }] },
        { last_insert_id: 1, rows_affected: 1 },
        { rows: [{ c: 3 }] },
      ])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    const out = await db.batch([
      db.prepare("SELECT 1"),
      db.prepare("INSERT INTO t VALUES (1)"),
      db.prepare("SELECT 3"),
    ]);
    expect(out[0].results).toEqual([{ k: "a" }, { k: "b" }]);
    expect(out[2].results).toEqual([{ c: 3 }]);
    expect(out.every((r) => r.success)).toBe(true);
  });

  it("reads SQL and params from statement objects that were never bound", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ rows: [] }, { rows: [] }])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual([["SELECT 1"], ["SELECT 2"]]);
  });

  it("exposes sql and params as public properties for Proxy-based consumers", () => {
    const db = makeAdapter(vi.fn() as unknown as typeof fetch);
    const stmt = db.prepare("SELECT 1").bind(9);
    expect(Reflect.get(stmt, "sql")).toBe("SELECT 1");
    expect(Reflect.get(stmt, "params")).toEqual([9]);
  });

  it("pads the results array when rqlite truncates it on error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([
        { rows_affected: 1 },
        { error: "UNIQUE constraint failed" },
      ])
    );
    const db = makeAdapter(fetchImpl as unknown as typeof fetch);
    await expect(
      db.batch([
        db.prepare("INSERT INTO t VALUES (1)"),
        db.prepare("INSERT INTO t VALUES (1)"),
        db.prepare("INSERT INTO t VALUES (2)"),
      ])
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
