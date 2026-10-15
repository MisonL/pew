/**
 * Integration tests for the d1-http container's node:http transport.
 * Unlike d1-http.test.ts (which tests createD1HttpServer.handle directly),
 * these drive the real exported handler over actual sockets so the 413 body
 * limit, header propagation and credentialed /health probe are exercised
 * wire-level.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createD1HttpNodeHandler } from "./server-d1-http";
import { createD1HttpServer } from "./d1-http";

const TOKEN = "d1-http-token";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeIdleConnections();
          server.close(() => resolve());
        })
    )
  );
});

function rqliteResponse(results: unknown[]) {
  return { ok: true, status: 200, json: () => Promise.resolve({ results }) } as unknown as Response;
}

async function startServer(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): Promise<number> {
  const d1 = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl });
  const handler = createD1HttpNodeHandler({
    d1,
    rqliteUrl: "http://rqlite:4001",
    fetchImpl,
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("server-d1-http transport", () => {
  it("answers 413 with Connection: close for an over-limit body", async () => {
    const port = await startServer(vi.fn() as never);
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);
    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: `SELECT '${oversized}'`, params: [] }),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
    expect(await res.json()).toEqual({ success: false, errors: [{ message: "Request body too large" }] });
  });

  it("propagates repeated response headers (Set-Cookie) instead of keeping only the last", async () => {
    // d1.handle() builds its own JSON envelope today, so the repeated-header
    // path is exercised with a stub whose response carries two Set-Cookie
    // entries — the transport must forward both, not collapse to the last.
    const stub = {
      handle: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: [], errors: [] }), {
          headers: [
            ["Set-Cookie", "a=1"],
            ["Set-Cookie", "b=2"],
          ],
        })
      ),
    };
    const server = createServer(
      createD1HttpNodeHandler({ d1: stub, rqliteUrl: "http://rqlite:4001", fetchImpl: vi.fn() as never })
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", params: [] }),
    });
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("keeps rejecting a prefix-sharing token through the full transport", async () => {
    const port = await startServer(vi.fn() as never);
    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN.slice(0, -1)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1", params: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("server-d1-http /health probe", () => {
  async function startHealthServer(
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  ): Promise<number> {
    const d1 = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl });
    const server = createServer(
      createD1HttpNodeHandler({ d1, rqliteUrl: "http://rqlite:4001", fetchImpl })
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("returns 200 only when rqlite answers the credentialed probe without an embedded error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{}]));
    const port = await startHealthServer(fetchImpl);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: { connected: true } });
    // The probe goes to the same linearizable /db/request path as writes.
    // No Bearer token here: the token is the web<->d1-http auth, rqlite knows
    // only Basic auth (attached when credentials are configured).
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/db/request?transaction=true&associative");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
  });

  it("returns 503 when rqlite answers 200 with an embedded results error", async () => {
    // The rqlite trap: HTTP 200 with SQL errors inside results[i].error must
    // NOT count as healthy.
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{ error: "authentication failed" }]));
    const port = await startHealthServer(fetchImpl);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", database: { connected: false } });
  });

  it("returns 503 when the probe fetch rejects (rqlite unreachable)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const port = await startHealthServer(fetchImpl);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", database: { connected: false } });
  });

  it("attaches Basic auth credentials when they are configured", async () => {
    const { toAuthorizationHeader } = await import("./basic-auth");
    const basic = { username: "pew", password: "pw" };
    const fetchImpl = vi.fn().mockResolvedValue(rqliteResponse([{}]));
    const d1 = createD1HttpServer({ baseUrl: "http://rqlite:4001", token: TOKEN, fetchImpl });
    const server = createServer(
      createD1HttpNodeHandler({ d1, rqliteUrl: "http://rqlite:4001", basicAuth: basic, fetchImpl })
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await fetch(`http://127.0.0.1:${port}/health`);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe(toAuthorizationHeader(basic));
  });
});
