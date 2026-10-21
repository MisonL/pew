import { describe, expect, it, vi } from "vitest";
import { assertAuthReconciled, assertCredentialConsistency } from "./migrate-cli";

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

  it("is a no-op when expectAuth is false", async () => {
    const f = vi.fn();
    await expect(assertAuthReconciled(f, URL, false)).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});
