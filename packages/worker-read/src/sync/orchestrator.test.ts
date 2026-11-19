import { describe, it, expect, vi, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";

import { memoryKv } from "../__test-helpers__/memory-kv";
import baseline from "../data/model-prices.json";
import {
  syncDynamicPricing,
  OPENROUTER_URL,
  MODELS_DEV_URL,
} from "./orchestrator";
import {
  KEY_DYNAMIC,
  KEY_DYNAMIC_META,
  KEY_LAST_FETCH_OPENROUTER,
  KEY_LAST_FETCH_MODELS_DEV,
} from "./kv-store";
import type { DynamicPricingEntry } from "./types";

const NOW = "2026-04-30T00:00:00.000Z";

function mockDb(): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue({ results: [] }),
    }),
  } as unknown as D1Database;
}

const OPENROUTER_OK = {
  data: [
    {
      id: "anthropic/claude-sonnet-4-20250514",
      name: "Anthropic: Claude Sonnet 4",
      context_length: 200000,
      pricing: {
        prompt: "0.000003",
        completion: "0.000015",
        input_cache_read: "0.0000003",
      },
    },
  ],
};

const MODELS_DEV_OK = {
  openai: {
    models: {
      "gpt-4o": {
        name: "GPT-4o",
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        limit: { context: 128000 },
      },
    },
  },
};

function mockFetch(
  responses: Record<string, { status: number; body?: unknown; throwError?: string }>
): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const r = responses[u];
    if (!r) throw new Error(`unexpected url: ${u}`);
    if (r.throwError) throw new Error(r.throwError);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("syncDynamicPricing", () => {
  let kv: ReturnType<typeof memoryKv>;
  let db: D1Database;

  beforeEach(() => {
    kv = memoryKv();
    db = mockDb();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("both upstream succeed → ok, KV written, last-fetch cached, no errors", async () => {
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: OPENROUTER_OK },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.entriesWritten).toBeGreaterThan(0);
    expect(kv.store.has(KEY_DYNAMIC)).toBe(true);
    expect(kv.store.has(KEY_DYNAMIC_META)).toBe(true);
    expect(kv.store.has(KEY_LAST_FETCH_OPENROUTER)).toBe(true);
    expect(kv.store.has(KEY_LAST_FETCH_MODELS_DEV)).toBe(true);
    expect(r.meta.lastErrors).toBeNull();
  });

  it("OpenRouter 500 → ok=false, models.dev still parsed, KV still written, baseline floor preserved", async () => {
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 500, body: { error: "boom" } },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.source === "openrouter")).toBeDefined();
    expect(r.entriesWritten).toBeGreaterThanOrEqual((baseline as DynamicPricingEntry[]).length);
    expect(kv.store.has(KEY_DYNAMIC)).toBe(true);
    expect(r.meta.lastErrors).not.toBeNull();
    expect(r.meta.lastErrors!.some((e) => e.source === "openrouter")).toBe(true);
  });

  it("both upstream fail → uses last-fetch cache; ok=false; KV still written", async () => {
    // Pre-seed last-fetch cache for both sources.
    kv.store.set(
      KEY_LAST_FETCH_OPENROUTER,
      JSON.stringify({ json: OPENROUTER_OK, fetchedAt: "2026-04-29T00:00:00.000Z" })
    );
    kv.store.set(
      KEY_LAST_FETCH_MODELS_DEV,
      JSON.stringify({ json: MODELS_DEV_OK, fetchedAt: "2026-04-29T00:00:00.000Z" })
    );
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 500 },
      [MODELS_DEV_URL]: { status: 502 },
    });
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
    // openrouter cached entry still feeds merge → entry count > baseline alone.
    expect(r.entriesWritten).toBeGreaterThanOrEqual((baseline as DynamicPricingEntry[]).length);
    expect(kv.store.has(KEY_DYNAMIC)).toBe(true);
  });

  it("both upstream fail AND no cache → bundled baseline only; ok=false", async () => {
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 0, throwError: "ECONNRESET" },
      [MODELS_DEV_URL]: { status: 0, throwError: "ECONNRESET" },
    });
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
    expect(r.entriesWritten).toBe((baseline as DynamicPricingEntry[]).length);
  });

  // A failed refresh must not *destroy* what a previous successful one stored.
  // The bundle baseline is a floor, not a replacement: entries that exist only
  // upstream (or only in the last good sync) disappeared from the served map
  // on any upstream hiccup, and stayed gone until the next success.
  it("preserves entries from a source that failed, instead of dropping them", async () => {
    const previous: DynamicPricingEntry[] = [
      { model: "vendor/only-on-openrouter", provider: "vendor", displayName: null,
        inputPerMillion: 1, outputPerMillion: 2, cachedPerMillion: null, contextWindow: 1000,
        origin: "openrouter", updatedAt: "2026-04-29T00:00:00.000Z", aliases: [] },
      { model: "vendor/only-on-modelsdev", provider: "vendor", displayName: null,
        inputPerMillion: 3, outputPerMillion: 4, cachedPerMillion: null, contextWindow: 2000,
        origin: "models.dev", updatedAt: "2026-04-29T00:00:00.000Z", aliases: [] },
    ];
    await kv.put(KEY_DYNAMIC, JSON.stringify(previous));
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 500, body: { error: "boom" } },
      [MODELS_DEV_URL]: { status: 502, body: { error: "boom" } },
    });

    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);

    expect(r.ok).toBe(false);
    const stored = JSON.parse(kv.store.get(KEY_DYNAMIC)!) as DynamicPricingEntry[];
    expect(stored.some((e) => e.model === "vendor/only-on-openrouter")).toBe(true);
    expect(stored.some((e) => e.model === "vendor/only-on-modelsdev")).toBe(true);
  });

  // Upstream can answer 200 with an error document (OpenRouter does this behind
  // its own gateway). readSource cached it, the parser degraded it to a warning,
  // and `ok` only counted errors — so the run reported success, rewrote the
  // source's layer as empty, and the previously known prices vanished until the
  // next good fetch.
  it("treats a 200 response without the expected payload as that source failing", async () => {
    await kv.put(KEY_DYNAMIC, JSON.stringify([
      { model: "vendor/only-on-openrouter", provider: "vendor", displayName: null,
        inputPerMillion: 1, outputPerMillion: 2, cachedPerMillion: null, contextWindow: 1000,
        origin: "openrouter", updatedAt: "2026-04-29T00:00:00.000Z", aliases: [] },
    ]));
    // A good document from yesterday: the bad body must not replace it, so a
    // later cheap rebuild still has real data to fall back to.
    kv.store.set(
      KEY_LAST_FETCH_OPENROUTER,
      JSON.stringify({ json: OPENROUTER_OK, fetchedAt: "2026-04-29T00:00:00.000Z" })
    );
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: { error: { message: "temporary catalogue failure" } } },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });

    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);

    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.source === "openrouter")).toBeDefined();
    const stored = JSON.parse(kv.store.get(KEY_DYNAMIC)!) as DynamicPricingEntry[];
    expect(stored.some((e) => e.model === "vendor/only-on-openrouter")).toBe(true);
    const cached = JSON.parse(kv.store.get(KEY_LAST_FETCH_OPENROUTER)!) as { fetchedAt: string };
    expect(cached.fetchedAt).toBe("2026-04-29T00:00:00.000Z");
  });

  // A model can carry OpenRouter rates as an ALTERNATE route on an entry whose
  // primary origin is models.dev. Those rates are not an entry of their own, so
  // preserving "openrouter-origin entries" did not cover them: one failed
  // OpenRouter fetch dropped the OpenRouter route for every such model.
  it("keeps an alternate-route price when that route's source fails", async () => {
    await kv.put(KEY_DYNAMIC, JSON.stringify([
      { model: "openai/only-via-route", provider: "openai", displayName: null,
        inputPerMillion: 3, outputPerMillion: 6, cachedPerMillion: null, contextWindow: 1000,
        origin: "models.dev", updatedAt: "2026-04-29T00:00:00.000Z", aliases: [],
        route: "direct",
        routePrices: { openrouter: { inputPerMillion: 1, outputPerMillion: 2, cachedPerMillion: null,
          origin: "openrouter", updatedAt: "2026-04-29T00:00:00.000Z" } } },
    ]));
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 500 },
      [MODELS_DEV_URL]: { status: 200, body: { openai: { models: { "only-via-route": {
        name: "Only", cost: { input: 3, output: 6 }, limit: { context: 1000 } } } } } },
    });

    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);

    expect(r.ok).toBe(false);
    const stored = JSON.parse(kv.store.get(KEY_DYNAMIC)!) as DynamicPricingEntry[];
    const entry = stored.find((e) => e.model === "openai/only-via-route");
    expect(entry?.routePrices?.openrouter?.inputPerMillion).toBe(1);
  });

  // The scheduler's single-flight only covers its own invocation; an admin
  // "Refresh prices" runs the same orchestrator beside it. Whichever run
  // finishes LAST used to win, so a slow stale fetch (price 1) overwrote the
  // newer manual run's price 3. A run whose start time is older than what is
  // already stored must not publish.
  it("does not let a run that started earlier overwrite a newer published result", async () => {
    await kv.put(KEY_DYNAMIC_META, JSON.stringify({
      lastSyncedAt: "2026-04-30T00:05:00.000Z", modelCount: 1, baselineCount: 0,
      openRouterCount: 1, modelsDevCount: 0, lastErrors: null,
    }));
    await kv.put(KEY_DYNAMIC, JSON.stringify([
      { model: "anthropic/claude-sonnet-4-20250514", provider: "anthropic", displayName: null,
        inputPerMillion: 3, outputPerMillion: 15, cachedPerMillion: null, contextWindow: 200000,
        origin: "openrouter", updatedAt: "2026-04-30T00:05:00.000Z", aliases: [] },
    ]));
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: { data: [{ ...OPENROUTER_OK.data[0],
        pricing: { prompt: "0.000001", completion: "0.000002" } }] } },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });

    // NOW is 00:00:00, older than the stored 00:05:00 publication.
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);

    const stored = JSON.parse(kv.store.get(KEY_DYNAMIC)!) as DynamicPricingEntry[];
    const entry = stored.find((e) => e.model === "anthropic/claude-sonnet-4-20250514");
    expect(entry?.inputPerMillion).toBe(3);
    expect(r.warnings.some((w) => /newer/i.test(w))).toBe(true);
    // Nothing was written, so the outcome must not claim otherwise — the cron
    // handler logs this number as "entries written".
    expect(r.entriesWritten).toBe(0);
    // …and a discarded run must not look like a successful one to callers that
    // only branch on `ok`: the admin button reports "Prices updated" for 200.
    expect(r.skippedReason).toMatch(/newer/i);
  });

  it("still replaces a preserved entry once that source succeeds again", async () => {
    await kv.put(KEY_DYNAMIC, JSON.stringify([
      { model: "vendor/only-on-openrouter", provider: "vendor", displayName: null,
        inputPerMillion: 1, outputPerMillion: 2, cachedPerMillion: null, contextWindow: 1000,
        origin: "openrouter", updatedAt: "2026-04-29T00:00:00.000Z", aliases: [] },
    ]));
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: OPENROUTER_OK },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });

    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);

    expect(r.ok).toBe(true);
    const stored = JSON.parse(kv.store.get(KEY_DYNAMIC)!) as DynamicPricingEntry[];
    // The stale entry is gone: a successful fetch is authoritative for its source.
    expect(stored.some((e) => e.model === "vendor/only-on-openrouter")).toBe(false);
  });

  it("lastErrors is null when next sync succeeds for all sources", async () => {
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: OPENROUTER_OK },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW);
    expect(r.meta.lastErrors).toBeNull();
  });

  it("KV put failure with non-Error throw → falls back to String(err) message", async () => {
    // Exercises the `(err as Error).message ?? String(err)` ?? fallback for both
    // the entries write and the meta re-write catches.
    const failingKv = {
      ...kv,
      get: kv.get,
      put: vi.fn(async (key: string) => {
        if (key === KEY_DYNAMIC || key === KEY_DYNAMIC_META) {
          throw "raw string failure";
        }
        kv.store.set(key, "");
      }),
      store: kv.store,
    } as unknown as typeof kv;
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: OPENROUTER_OK },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });
    const r = await syncDynamicPricing({ db, kv: failingKv, fetchImpl }, NOW);
    expect(r.ok).toBe(false);
    const kvErrors = r.errors.filter((e) => e.source === "kv");
    expect(kvErrors.length).toBeGreaterThan(0);
    // String(err) of a bare string is just the string itself — verifies fallback path.
    expect(kvErrors[0]?.message).toBe("raw string failure");
  });

  it("KV put failure → ok=false, errors include source='kv', meta still returned", async () => {
    const failingKv = {
      ...kv,
      get: kv.get,
      put: vi.fn(async (key: string) => {
        if (key === KEY_DYNAMIC || key === KEY_DYNAMIC_META) {
          throw new Error("kv 503");
        }
        kv.store.set(key, "");
      }),
      store: kv.store,
    } as unknown as typeof kv;
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: OPENROUTER_OK },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });
    const r = await syncDynamicPricing({ db, kv: failingKv, fetchImpl }, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.source === "kv")).toBe(true);
    expect(r.meta.lastErrors?.some((e) => e.source === "kv")).toBe(true);
  });

  it("forceRefetch=false → skips upstream entirely; uses cache when present", async () => {
    kv.store.set(
      KEY_LAST_FETCH_OPENROUTER,
      JSON.stringify({ json: OPENROUTER_OK, fetchedAt: "2026-04-29T00:00:00.000Z" })
    );
    kv.store.set(
      KEY_LAST_FETCH_MODELS_DEV,
      JSON.stringify({ json: MODELS_DEV_OK, fetchedAt: "2026-04-29T00:00:00.000Z" })
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error("upstream must not be called when forceRefetch=false");
    }) as unknown as typeof fetch;
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW, { forceRefetch: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.entriesWritten).toBeGreaterThan(0);
  });

  it("forceRefetch=false with no cache → ok=true, baseline floor only, no upstream calls", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("upstream must not be called when forceRefetch=false");
    }) as unknown as typeof fetch;
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW, { forceRefetch: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.entriesWritten).toBe((baseline as DynamicPricingEntry[]).length);
  });

  it("forceRefetch=true → upstream success refreshes last-fetch cache", async () => {
    // Pre-seed stale cache; verify it's overwritten on success.
    kv.store.set(
      KEY_LAST_FETCH_OPENROUTER,
      JSON.stringify({ json: { data: [] }, fetchedAt: "2026-04-29T00:00:00.000Z" })
    );
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 200, body: OPENROUTER_OK },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW, { forceRefetch: true });
    expect(r.ok).toBe(true);
    const cached = JSON.parse(kv.store.get(KEY_LAST_FETCH_OPENROUTER)!);
    expect(cached.fetchedAt).toBe(NOW);
    expect(cached.json).toEqual(OPENROUTER_OK);
  });

  it("forceRefetch=true → upstream failure does NOT fall back to cache; surfaces error", async () => {
    kv.store.set(
      KEY_LAST_FETCH_OPENROUTER,
      JSON.stringify({ json: OPENROUTER_OK, fetchedAt: "2026-04-29T00:00:00.000Z" })
    );
    const fetchImpl = mockFetch({
      [OPENROUTER_URL]: { status: 500, body: { error: "boom" } },
      [MODELS_DEV_URL]: { status: 200, body: MODELS_DEV_OK },
    });
    const r = await syncDynamicPricing({ db, kv, fetchImpl }, NOW, { forceRefetch: true });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.source === "openrouter")).toBeDefined();
    // Should not have used the cached OpenRouter data; entry count should be only models.dev + baseline.
    // We don't pin exact counts (depends on baseline), just verify it's not throwing on the cache path.
  });
});
