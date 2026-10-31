import { describe, expect, it, vi } from "vitest";
import {
  assertAuthReconciled,
  assertCredentialConsistency,
  waitForRqlite,
} from "./migrate-cli";

const URL = "http://rqlite:4001";

function stub(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("assertCredentialConsistency", () => {
  // The dangerous state this guards: render-rqlite-auth.sh deletes auth.json
  // when the three vars are not all set, rqlite then starts WITHOUT -auth, and
  // assertAuthReconciled skips its probe because expectAuth only looks at the
  // full pair — the whole stack runs unauthenticated with no warning.
  it("passes when all three credentials are set", () => {
    expect(() =>
      assertCredentialConsistency({
        RQLITE_USERNAME: "pew",
        RQLITE_PASSWORD: "pw",
        RQLITE_JOIN_PASSWORD: "join",
      })
    ).not.toThrow();
  });

  it("passes when none are set (auth intentionally disabled)", () => {
    expect(() => assertCredentialConsistency({})).not.toThrow();
    // compose injects `${VAR:-}` as EMPTY STRINGS — must behave like unset.
    expect(() =>
      assertCredentialConsistency({
        RQLITE_USERNAME: "",
        RQLITE_PASSWORD: "",
        RQLITE_JOIN_PASSWORD: "",
      })
    ).not.toThrow();
  });

  it("fails closed when only the JOIN password is set (auth.json deleted, server open)", () => {
    expect(() => assertCredentialConsistency({ RQLITE_JOIN_PASSWORD: "join" })).toThrow(
      /partially configured: RQLITE_USERNAME, RQLITE_PASSWORD empty/
    );
  });

  it("fails closed when the full pair is set but the JOIN password is missing", () => {
    expect(() =>
      assertCredentialConsistency({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw" })
    ).toThrow(/partially configured: RQLITE_JOIN_PASSWORD empty/);
  });
});

describe("assertAuthReconciled (expectAuth=true)", () => {
  it("passes when /status shows auth enabled and anonymous query is 401", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "enabled" } }))
      .mockImplementationOnce(stub(401, { error: "unauthorized" }));
    await expect(assertAuthReconciled(f, URL, true)).resolves.toBeUndefined();
  });

  it("fails when auth is disabled (credentials configured but server open)", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "disabled" } }));
    await expect(assertAuthReconciled(f, URL, true))
      .rejects.toThrow(/credentials configured but auth is disabled/);
  });

  it("fails when anonymous query succeeds (200 instead of 401)", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "enabled" } }))
      .mockImplementationOnce(stub(200, { results: [{ rows: [] }] }));
    await expect(assertAuthReconciled(f, URL, true))
      .rejects.toThrow(/anonymous query succeeded/);
  });

  it("fails when /status itself is not 200 (the '*' entry lost its permissions)", async () => {
    // The old check was `if (status.ok && body.http?.auth !== "enabled")`, so a
    // 401 on /status skipped the assertion entirely: the anonymous-SELECT probe
    // still 401'd and the reconciliation "passed" without ever confirming auth
    // was on. The eventual failure surfaced at the first data query with a
    // message pointing at the wrong layer.
    const f = vi.fn().mockImplementationOnce(stub(401, { error: "unauthorized" }));
    await expect(assertAuthReconciled(f, URL, true))
      .rejects.toThrow(/\/status answered 401/);
  });

  it("fails when /status returns a non-JSON body", async () => {
    const f = vi.fn().mockImplementationOnce(async () => new Response("<html>", { status: 200 }));
    await expect(assertAuthReconciled(f, URL, true))
      .rejects.toThrow(/non-JSON body/);
  });

  it("is a no-op when expectAuth is false", async () => {
    const f = vi.fn();
    await expect(assertAuthReconciled(f, URL, false)).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("caps both probes with their own timeout", async () => {
    // migrate is the gate for read/ingest/scheduler/d1-http/web: a rqlite that
    // accepts TCP but never answers would hang these fetches for undici's
    // 300 s headersTimeout each (two sequential probes), and compose would
    // never start the rest of the stack. Every probe carries a signal, same
    // rule waitForRqlite already documents.
    const signals: Array<AbortSignal | undefined> = [];
    const f = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return signals.length === 1
        ? new Response(JSON.stringify({ http: { auth: "enabled" } }), { status: 200 })
        : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    });
    await expect(assertAuthReconciled(f, URL, true)).resolves.toBeUndefined();
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("waitForRqlite", () => {
  const noDelay = async () => {};

  it("resolves as soon as /readyz answers 200", async () => {
    const f = vi.fn(async () => new Response("ready", { status: 200 }));
    await expect(waitForRqlite(60_000, { baseUrl: URL, fetchImpl: f, delay: noDelay })).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fails fast with an auth diagnosis on 401 instead of burning the timeout", async () => {
    // With auth enabled and a broken auth.json (missing the '*' status/ready
    // entry), /readyz answers 401 forever. The old loop treated that as
    // "not up yet", retried for the whole timeout and finally reported
    // "did not become ready" — pointing the operator at the wrong problem.
    const f = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    await expect(waitForRqlite(60_000, { baseUrl: URL, fetchImpl: f, delay: noDelay }))
      .rejects.toThrow(/401 on \/readyz: auth is enabled/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fails fast on 403 for the same reason", async () => {
    const f = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(waitForRqlite(60_000, { baseUrl: URL, fetchImpl: f, delay: noDelay }))
      .rejects.toThrow(/403 on \/readyz: auth is enabled/);
  });

  it("retries through connection errors and 5xx until the deadline", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("connect ECONNREFUSED");
      return new Response("not ready", { status: 503 });
    });
    await expect(
      waitForRqlite(10_000, {
        baseUrl: URL,
        fetchImpl: f,
        // Never-ending retry loop with a no-op delay: cut it off manually.
        delay: async () => {
          if (calls >= 3) throw new Error("stop");
        },
      })
    ).rejects.toThrow("stop");
    expect(calls).toBe(3);
  });

  it("reports readiness (not auth) when the deadline passes on genuine unavailability", async () => {
    const f = vi.fn(async () => new Response("", { status: 503 }));
    await expect(
      waitForRqlite(50, { baseUrl: URL, fetchImpl: f, delay: async () => {} })
    ).rejects.toThrow(/did not become ready/);
  });

  it("caps each probe with its own timeout so a silent connection cannot outlast the deadline", async () => {
    // Node's fetch has no default timeout: a rqlite that accepts TCP but never
    // answers would let one attempt run for minutes and blow past the loop
    // deadline. Every probe must carry a signal.
    const signals: Array<AbortSignal | undefined> = [];
    const f = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      throw new Error("aborted");
    });
    await expect(
      waitForRqlite(50, { baseUrl: URL, fetchImpl: f, delay: async () => {} })
    ).rejects.toThrow(/did not become ready/);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});
