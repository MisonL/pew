import { describe, expect, it, vi } from "vitest";
import { assertAuthReconciled } from "./migrate-cli";

const URL = "http://rqlite:4001";

function stub(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("assertAuthReconciled (expectAuth=true)", () => {
  it("passes when /status shows auth enabled and anonymous query is 401", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "enabled" } }))
      .mockImplementationOnce(stub(401, { error: "unauthorized" }));
    await expect(assertAuthReconciled(f as typeof fetch, URL, true)).resolves.toBeUndefined();
  });

  it("fails when auth is disabled (credentials configured but server open)", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "disabled" } }));
    await expect(assertAuthReconciled(f as typeof fetch, URL, true))
      .rejects.toThrow(/credentials configured but auth is disabled/);
  });

  it("fails when anonymous query succeeds (200 instead of 401)", async () => {
    const f = vi.fn()
      .mockImplementationOnce(stub(200, { http: { auth: "enabled" } }))
      .mockImplementationOnce(stub(200, { results: [{ rows: [] }] }));
    await expect(assertAuthReconciled(f as typeof fetch, URL, true))
      .rejects.toThrow(/anonymous query succeeded/);
  });

  it("is a no-op when expectAuth is false", async () => {
    const f = vi.fn();
    await expect(assertAuthReconciled(f as typeof fetch, URL, false)).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});
