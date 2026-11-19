import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  SCOPE_STORAGE_KEY,
  loadScopeFromStorage,
  saveScopeToStorage,
  resolveScope,
  type ScopeSelection,
} from "@/lib/leaderboard-scope";

// Mock localStorage
const store = new Map<string, string>();
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, val: string) => store.set(key, val)),
  removeItem: vi.fn((key: string) => store.delete(key)),
};

Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  writable: true,
});

describe("leaderboard-scope", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("SCOPE_STORAGE_KEY is defined", () => {
    expect(SCOPE_STORAGE_KEY).toBe("pew:leaderboard:scope");
  });

  // ---- loadScopeFromStorage ----

  it("returns null when nothing stored", () => {
    expect(loadScopeFromStorage()).toBeNull();
  });

  it("loads global scope", () => {
    store.set(SCOPE_STORAGE_KEY, JSON.stringify({ type: "global" }));
    expect(loadScopeFromStorage()).toEqual({ type: "global" });
  });

  it("loads org scope with id", () => {
    const scope: ScopeSelection = { type: "org", id: "o1" };
    store.set(SCOPE_STORAGE_KEY, JSON.stringify(scope));
    expect(loadScopeFromStorage()).toEqual(scope);
  });

  it("loads team scope with id", () => {
    const scope: ScopeSelection = { type: "team", id: "t1" };
    store.set(SCOPE_STORAGE_KEY, JSON.stringify(scope));
    expect(loadScopeFromStorage()).toEqual(scope);
  });

  it("returns null for org scope without id", () => {
    store.set(SCOPE_STORAGE_KEY, JSON.stringify({ type: "org" }));
    expect(loadScopeFromStorage()).toBeNull();
  });

  it("returns null for team scope without id", () => {
    store.set(SCOPE_STORAGE_KEY, JSON.stringify({ type: "team" }));
    expect(loadScopeFromStorage()).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    store.set(SCOPE_STORAGE_KEY, "not-json");
    expect(loadScopeFromStorage()).toBeNull();
  });

  it("returns null when localStorage throws", () => {
    mockLocalStorage.getItem.mockImplementationOnce(() => {
      throw new Error("denied");
    });
    expect(loadScopeFromStorage()).toBeNull();
  });

  // ---- saveScopeToStorage ----

  it("saves scope to localStorage", () => {
    const scope: ScopeSelection = { type: "global" };
    saveScopeToStorage(scope);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      SCOPE_STORAGE_KEY,
      JSON.stringify(scope),
    );
  });

  it("silently catches write errors", () => {
    mockLocalStorage.setItem.mockImplementationOnce(() => {
      throw new Error("quota");
    });
    expect(() => saveScopeToStorage({ type: "global" })).not.toThrow();
  });

  // ---- resolveScope ----

  it("keeps a team scope that the loaded memberships confirm", () => {
    expect(resolveScope({ type: "team", id: "t1" }, [], [{ id: "t1" }], false))
      .toEqual({ scope: { type: "team", id: "t1" }, unverified: false });
  });

  it("drops a team scope the memberships say is gone", () => {
    expect(resolveScope({ type: "team", id: "t1" }, [], [{ id: "other" }], false))
      .toEqual({ scope: { type: "global" }, unverified: false });
  });

  it("keeps the stored scope when the membership lists could not be loaded", () => {
    // Both lists are empty because /api/teams failed. An empty list is not
    // evidence of "not a member": validating against it silently turned a
    // team board into the global one, and the scope dropdown disappeared.
    expect(resolveScope({ type: "team", id: "t1" }, [], [], true))
      .toEqual({ scope: { type: "team", id: "t1" }, unverified: true });
    expect(resolveScope({ type: "org", id: "o1" }, [], [], true))
      .toEqual({ scope: { type: "org", id: "o1" }, unverified: true });
  });

  it("keeps a global scope global whether or not memberships loaded", () => {
    expect(resolveScope({ type: "global" }, [{ id: "o1" }], [{ id: "t1" }], false))
      .toEqual({ scope: { type: "global" }, unverified: false });
    expect(resolveScope({ type: "global" }, [], [], true))
      .toEqual({ scope: { type: "global" }, unverified: false });
  });
});
