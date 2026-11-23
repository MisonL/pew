"use client";

import { useEffect, useState } from "react";
import type {
  DynamicPricingEntryDto,
  DynamicPricingMetaDto,
} from "@/lib/rpc-types";
import { toErrorMessage } from "@/lib/error-message";

// ---------------------------------------------------------------------------
// Module-level singleton cache
//
// Many tooltip icons across the dashboard subscribe to the same dataset, so
// fetching from inside each component would fan out to N parallel HTTP calls.
// We keep a single in-memory promise and broadcast updates to subscribers.
// ---------------------------------------------------------------------------

interface PricingEntriesPayload {
  entries: DynamicPricingEntryDto[];
  meta: DynamicPricingMetaDto | null;
}

interface CacheState {
  data: PricingEntriesPayload | null;
  loading: boolean;
  error: string | null;
  cachedAt: number;
}

const STALE_MS = 5 * 60 * 1000;

let cache: CacheState = { data: null, loading: false, error: null, cachedAt: 0 };
let inflight: Promise<PricingEntriesPayload> | null = null;
// Every invalidation bumps this. An in-flight response from before the bump
// may resolve its own caller but must not populate the cache — otherwise a
// force-sync whose refetch raced the pre-sync response shows stale prices
// as if they were fresh.
let generation = 0;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((fn) => {
    fn();
  });
}

async function loadOnce(): Promise<PricingEntriesPayload> {
  if (inflight) return inflight;
  const myGen = generation;
  cache = { ...cache, loading: true, error: null };
  notify();

  const promise = (async () => {
    try {
      const res = await fetch("/api/pricing/models");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PricingEntriesPayload;
      if (myGen === generation) {
        cache = { data: json, loading: false, error: null, cachedAt: Date.now() };
        notify();
      }
      return json;
    } catch (err) {
      if (myGen === generation) {
        const message = toErrorMessage(err);
        cache = { ...cache, loading: false, error: message };
        notify();
      }
      throw err;
    } finally {
      // Only the current generation's request owns the slot; an invalidated
      // response clearing it would race the refetch that replaced it.
      if (myGen === generation) inflight = null;
    }
  })();

  inflight = promise;
  return promise;
}

interface UsePricingEntriesResult {
  entries: DynamicPricingEntryDto[];
  meta: DynamicPricingMetaDto | null;
  loading: boolean;
  error: string | null;
}

/**
 * Invalidate the pricing entries cache and trigger a background refetch.
 * All mounted subscribers are notified when fresh data arrives.
 * Call after force-sync or any operation that updates pricing data.
 */
export function invalidatePricingEntries(): void {
  cache = { ...cache, cachedAt: 0 };
  generation++;
  // Start the refetch even when a load is in flight: that response predates
  // this invalidation and (per the generation check in loadOnce) can no
  // longer fill the cache. Skipping here let a force-sync landing during a
  // slow fetch silently keep showing the pre-sync prices.
  inflight = null;
  void loadOnce().catch(() => {
    // Errors are surfaced via loadOnce's own state update; ignore here.
  });
}

/**
 * Subscribe to the global dynamic-pricing entries cache. The first
 * caller triggers a single fetch from `/api/pricing/models`; later
 * callers receive the cached result without re-fetching.
 */
export function usePricingEntries(): UsePricingEntriesResult {
  const [, force] = useState(0);

  useEffect(() => {
    const sub = () => force((n) => n + 1);
    subscribers.add(sub);
    const isStale = cache.data !== null && Date.now() - cache.cachedAt > STALE_MS;
    if ((cache.data === null || isStale) && !inflight) {
      void loadOnce().catch(() => {
        /* error already written to cache */
      });
    }
    return () => {
      subscribers.delete(sub);
    };
  }, []);

  return {
    entries: cache.data?.entries ?? [],
    meta: cache.data?.meta ?? null,
    loading: cache.loading,
    error: cache.error,
  };
}

// ---------------------------------------------------------------------------
// Test-only reset hook (not exported in production code paths).
// ---------------------------------------------------------------------------

/** @internal Reset the module-level cache. Test use only. */
export function __resetPricingEntriesCacheForTests(): void {
  cache = { data: null, loading: false, error: null, cachedAt: 0 };
  inflight = null;
  generation++;
  subscribers.clear();
}

/** @internal Trigger a load mimicking the hook's guard. Test use only. */
export async function __triggerLoadForTests(): Promise<PricingEntriesPayload> {
  const isStale = cache.data !== null && Date.now() - cache.cachedAt > STALE_MS;
  if (cache.data !== null && !isStale) return cache.data;
  if (inflight) return inflight;
  return loadOnce();
}

/** @internal Read current cache state. Test use only. */
export function __getCacheForTests(): CacheState {
  return { ...cache };
}
