import { describe, it, expect, vi } from "vitest";
import { createD1HttpServer } from "./d1-http";

const TOKEN = "d1-http-token";

function rqliteResponse(results: unknown[], status = 200) {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve({ results }),
  } as unknown as Response;
}

function post(body: unknown, token = TOKEN) {
  return new Request("http://d1-http:8788/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("d1-http", () => {
  it("rejects requests without the bearer token", async () => {
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: vi.fn() as never });
    const res = await server.handle(
      new Request("http://d1-http:8788/query", { method: "POST", body: "{}" })
    );
    expect(res.status).toBe(401);
  });

  it("rejects a token that shares a prefix with the real one", async () => {
    // Guards the constant-time compare: a shorter/longer or prefix-matching
    // Authorization must still be rejected.
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: vi.fn() as never });
    for (const bad of [TOKEN.slice(0, -1), `${TOKEN}x`, "x"]) {
      const res = await server.handle(post({ sql: "SELECT 1", params: [] }, bad));
      expect(res.status).toBe(401);
    }
  });

  it("wraps a single query in the D1 envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{ rows: [{ a: 1 }], time: 0.002 }]));
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "SELECT a FROM t", params: [] }));
    expect(await res.json()).toEqual({
      success: true,
      result: [{ success: true, results: [{ a: 1 }], meta: { changes: 0, duration: 2 } }],
      errors: [],
    });
  });

  it("routes a single INSERT through /db/request so writes are not rejected", async () => {
    // /db/query rejects every write ("attempt to change database via query
    // operation", verified against rqlite 10.5.3). lib/d1.ts posts execute()
    // to the same <mount>/query endpoint as query(), so a bare {sql} body can
    // absolutely be a write — it must land on /db/request.
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ last_insert_id: 4, rows_affected: 1, time: 0.001 }])
    );
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "INSERT INTO t (v) VALUES (?)", params: ["x"] }));
    const body = await res.json();
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://rqlite:4001/db/request?transaction=true&associative&timings");
    expect(body.result[0].meta.changes).toBe(1);
  });

  it("reports changes 0 rather than omitting meta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{ last_insert_id: 9 }]));
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "UPDATE t SET a = 1 WHERE 0", params: [] }));
    const body = await res.json();
    expect(body.result[0].meta.changes).toBe(0);
  });

  it("keeps the batch result array length equal to the statement count on error", async () => {
    // rqlite truncates results at the failing statement.
    const fetchImpl = vi.fn().mockResolvedValue(
      rqliteResponse([{ rows_affected: 1 }, { error: "UNIQUE constraint failed" }])
    );
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(
      post({
        batch: [
          { sql: "INSERT INTO t VALUES (1)", params: [] },
          { sql: "INSERT INTO t VALUES (1)", params: [] },
          { sql: "INSERT INTO t VALUES (2)", params: [] },
        ],
      })
    );
    const body = await res.json();
    expect(body.result).toHaveLength(3);
    expect(body.success).toBe(false);
    expect(body.errors[0].message).toMatch(/UNIQUE constraint failed/);
  });

  it("returns success false when a statement fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{ error: "no such table: nope" }]));
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ sql: "SELECT * FROM nope", params: [] }));
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.errors[0].message).toMatch(/no such table/);
  });

  it("returns an empty result array for an empty batch", async () => {
    const fetchImpl = vi.fn();
    const server = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl: fetchImpl as never });
    const res = await server.handle(post({ batch: [] }));
    expect(await res.json()).toEqual({ success: true, result: [], errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
