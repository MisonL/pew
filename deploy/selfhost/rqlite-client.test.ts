import { describe, it, expect, vi } from "vitest";
import { createRqliteDdlExecutor } from "./rqlite-client";

const BASE = "http://rqlite:4001";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("createRqliteDdlExecutor", () => {
  it("sends DDL as a single atomic transaction with norwtime&norwrandom", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{}, {}] }));
    const ddl = createRqliteDdlExecutor({ baseUrl: BASE, fetchImpl: fetchImpl as never });
    await ddl(["CREATE TABLE a(x)", "CREATE INDEX i ON a(x)"]);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    // transaction=true is what makes a multi-statement DDL batch all-or-nothing;
    // norwtime&norwrandom is what keeps DEFAULT (datetime('now')) etc. verbatim.
    expect(url).toBe(`${BASE}/db/execute?transaction=true&norwtime&norwrandom`);
    expect(JSON.parse(init.body)).toEqual([["CREATE TABLE a(x)"], ["CREATE INDEX i ON a(x)"]]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("short-circuits an empty statement list without calling rqlite", async () => {
    const fetchImpl = vi.fn();
    const ddl = createRqliteDdlExecutor({ baseUrl: BASE, fetchImpl: fetchImpl as never });
    await ddl([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{}] }));
    const ddl = createRqliteDdlExecutor({ baseUrl: `${BASE}/`, fetchImpl: fetchImpl as never });
    await ddl(["CREATE TABLE a(x)"]);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `${BASE}/db/execute?transaction=true&norwtime&norwrandom`
    );
  });

  it("throws on a top-level error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "leader not found" }));
    const ddl = createRqliteDdlExecutor({ baseUrl: BASE, fetchImpl: fetchImpl as never });
    await expect(ddl(["CREATE TABLE a(x)"])).rejects.toThrow(/leader not found/);
  });

  it("throws on a per-statement error inside HTTP 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{}, { error: "table a already exists" }] })
    );
    const ddl = createRqliteDdlExecutor({ baseUrl: BASE, fetchImpl: fetchImpl as never });
    await expect(ddl(["CREATE TABLE a(x)", "CREATE TABLE a(x)"])).rejects.toThrow(
      /already exists/
    );
  });

  it("throws on a non-OK HTTP status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const ddl = createRqliteDdlExecutor({ baseUrl: BASE, fetchImpl: fetchImpl as never });
    await expect(ddl(["CREATE TABLE a(x)"])).rejects.toThrow(/rqlite HTTP 503/);
  });

  it("sends a bearer token when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{}] }));
    const ddl = createRqliteDdlExecutor({ baseUrl: BASE, token: "tok", fetchImpl: fetchImpl as never });
    await ddl(["CREATE TABLE a(x)"]);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].headers.Authorization).toBe(
      "Bearer tok"
    );
  });

  it("sends Basic auth when basicAuth is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{}] }));
    const ddl = createRqliteDdlExecutor({
      baseUrl: BASE,
      basicAuth: { username: "pew", password: "s:ecret" },
      fetchImpl: fetchImpl as never,
    });
    await ddl(["CREATE TABLE a(x)"]);
    const expected = `Basic ${Buffer.from("pew:s:ecret").toString("base64")}`;
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].headers.Authorization).toBe(
      expected
    );
  });

  it("sends NO Authorization header when neither token nor basicAuth is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{}] }));
    const ddl = createRqliteDdlExecutor({ baseUrl: BASE, fetchImpl: fetchImpl as never });
    await ddl(["CREATE TABLE a(x)"]);
    expect(
      (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].headers.Authorization
    ).toBeUndefined();
  });
});
