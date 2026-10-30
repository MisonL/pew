import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  __loadIsAdminForTests,
  __resetAdminCacheForTests,
} from "@/hooks/use-admin";

// useAdmin is a React hook, so the interesting logic (single-flight + TTL) is
// exercised through the module-level loader the hook calls, mirroring the
// usePricingEntries test.

function mockAdminCheck(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(body),
  });
}

describe("useAdmin — module cache behaviour", () => {
  beforeEach(() => {
    __resetAdminCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fetches once and serves the cached answer within the window", async () => {
    const fetchMock = mockAdminCheck({ isAdmin: true });
    vi.stubGlobal("fetch", fetchMock);

    await expect(__loadIsAdminForTests()).resolves.toBe(true);
    await expect(__loadIsAdminForTests()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent loads into one request", async () => {
    let release!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const a = __loadIsAdminForTests();
    const b = __loadIsAdminForTests();
    release({ ok: true, json: () => Promise.resolve({ isAdmin: true }) });
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches after the window expires", async () => {
    const fetchMock = mockAdminCheck({ isAdmin: true });
    vi.stubGlobal("fetch", fetchMock);

    await __loadIsAdminForTests();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    await __loadIsAdminForTests();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a non-ok response as not admin", async () => {
    vi.stubGlobal("fetch", mockAdminCheck({ error: "Forbidden" }, false));
    await expect(__loadIsAdminForTests()).resolves.toBe(false);
  });

  it("treats a network failure as not admin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(__loadIsAdminForTests()).resolves.toBe(false);
  });
});
