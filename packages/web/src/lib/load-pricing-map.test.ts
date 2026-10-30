/**
 * Partial-degradation matrix for the loadPricingMap helper.
 *
 * Two server entry points (/api/pricing and /api/usage/by-device) both go
 * through this helper so they share one policy. The helper now only depends
 * on the dynamic dataset (worker-read KV with bundled baseline underneath);
 * if that call fails, we fall back to the static safety-net.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPricingMap, resetPricingMapCache } from "./load-pricing-map";
import { DEFAULT_PREFIX_PRICES, DEFAULT_SOURCE_DEFAULTS } from "./pricing";
import type { DbRead } from "./db";

type PricingMapDb = Pick<DbRead, "getDynamicPricing">;

function makeDb(overrides: {
  dynamic?: () => ReturnType<DbRead["getDynamicPricing"]>;
}): PricingMapDb {
  return {
    getDynamicPricing:
      overrides.dynamic ??
      vi.fn().mockResolvedValue({ entries: [], servedFrom: "baseline" }),
  };
}

describe("loadPricingMap", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetPricingMapCache();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("dynamic succeeds → buildPricingMap with the entries", async () => {
    const db = makeDb({
      dynamic: vi.fn().mockResolvedValue({
        entries: [
          {
            model: "claude-sonnet-4-20250514",
            provider: "Anthropic",
            displayName: "Claude Sonnet 4",
            inputPerMillion: 3,
            outputPerMillion: 15,
            cachedPerMillion: 0.3,
            contextWindow: 200000,
            origin: "baseline" as const,
            updatedAt: "2026-04-30T00:00:00.000Z",
          },
        ],
        servedFrom: "kv" as const,
      }),
    });
    const map = await loadPricingMap(db);
    expect(map.models["claude-sonnet-4-20250514"]).toEqual({
      input: 3,
      output: 15,
      cached: 0.3,
    });
  });

  it("dynamic rejects → safety-net only (prefixes + source defaults + fallback)", async () => {
    const db = makeDb({
      dynamic: vi.fn().mockRejectedValue(new Error("worker-read down")),
    });
    const map = await loadPricingMap(db);
    expect(map.models).toEqual({});
    expect(map.prefixes).toEqual(DEFAULT_PREFIX_PRICES);
    expect(map.sourceDefaults).toEqual(DEFAULT_SOURCE_DEFAULTS);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "loadPricingMap: dynamic pricing unavailable",
    );
  });

  it("never throws — even when db.getDynamicPricing throws synchronously", async () => {
    const db: PricingMapDb = {
      getDynamicPricing: vi.fn(() => {
        throw new Error("sync throw");
      }),
    };
    await expect(loadPricingMap(db)).resolves.toBeDefined();
  });

  it("serves from the module cache within the window and refetches after reset", async () => {
    const dynamic = vi.fn().mockResolvedValue({ entries: [], servedFrom: "baseline" });
    const db = makeDb({ dynamic });
    const first = await loadPricingMap(db);
    const second = await loadPricingMap(db);
    expect(second).toBe(first);
    expect(dynamic).toHaveBeenCalledTimes(1);
    resetPricingMapCache();
    await loadPricingMap(db);
    expect(dynamic).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent loads into one fetch", async () => {
    let release!: (value: { entries: never[]; servedFrom: "baseline" }) => void;
    const dynamic = vi.fn().mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const db = makeDb({ dynamic });
    const a = loadPricingMap(db);
    const b = loadPricingMap(db);
    release({ entries: [], servedFrom: "baseline" });
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(dynamic).toHaveBeenCalledTimes(1);
  });

  it("identifies price content independently of fetch time, including alternate route writes", async () => {
    const entry = { model: "openai/test", provider: "OpenAI", displayName: null, contextWindow: null,
      inputPerMillion: 4, outputPerMillion: 20, cachedPerMillion: 0.4, cacheWritePerMillion: 5,
      origin: "models.dev" as const, updatedAt: "2026-09-01T00:00:00.000Z", route: "direct" as const,
      routePrices: { openrouter: { inputPerMillion: 2, outputPerMillion: 10, cachedPerMillion: 0.2,
        cacheWritePerMillion: 2.5, origin: "openrouter", updatedAt: "2026-09-01T00:00:00.000Z" } } };
    const get = (value: typeof entry) => {
      resetPricingMapCache();
      return loadPricingMap(makeDb({ dynamic: vi.fn().mockResolvedValue({ entries: [value], servedFrom: "kv" }) }));
    };
    const first = await get(entry);
    const later = { ...entry, updatedAt: "2026-09-02T00:00:00.000Z", routePrices: { openrouter: {
      ...entry.routePrices.openrouter, updatedAt: "2026-09-02T00:00:00.000Z",
    } } };
    const second = await get(later);
    expect(second.meta?.snapshotId).toBe(first.meta?.snapshotId);
    expect(second.meta?.fetchedAt).toBe(later.updatedAt);
    expect(second.meta?.effectiveAt).toBeNull();
    later.routePrices.openrouter.cacheWritePerMillion = 3;
    expect((await get(later)).meta?.snapshotId).not.toBe(first.meta?.snapshotId);
  });
});
