/**
 * Server-only helper that loads the merged PricingMap.
 *
 * Two routes need this exact policy (`/api/pricing` and `/api/usage/by-device`)
 * — inlining it twice guarantees drift, so both go through here.
 *
 * Partial-degradation:
 *   - dynamic succeeds → buildPricingMap({ dynamic })
 *   - dynamic fails    → getDefaultPricingMap() (prefix/source/fallback only)
 *
 * Never throws. Each rejection is logged with its source tag.
 *
 * Per-process cache: the dynamic catalogue is one KV read plus a rebuild over
 * the whole entry list, and the dashboard calls this on every page load. The
 * entry (60 s) matches /api/pricing's own `max-age=60`, so a client can never
 * see a map fresher than this one would serve. `resetPricingMapCache` drops it
 * the moment the catalogue is actually mutated, so an admin force-sync is
 * reflected immediately rather than within the window.
 */

import type { DbRead } from "./db";
import { createHash } from "node:crypto";
import {
  buildPricingMap,
  getDefaultPricingMap,
  type PricingMap,
} from "./pricing";

type PricingMapDb = Pick<DbRead, "getDynamicPricing">;

const CACHE_MS = 60_000;

interface CachedMap {
  map: PricingMap;
  at: number;
}

let cached: CachedMap | null = null;
let inflight: Promise<PricingMap> | null = null;

function isFresh(entry: CachedMap): boolean {
  return Date.now() - entry.at < CACHE_MS;
}

export function resetPricingMapCache(): void {
  cached = null;
  inflight = null;
}

async function loadPricingMapUncached(db: PricingMapDb): Promise<PricingMap> {
  try {
    const dynamicResult = await db.getDynamicPricing();
    const dynamic = dynamicResult?.entries ?? [];
    const map = buildPricingMap({ dynamic });
    // Price identity excludes fetch timestamps: fetchedAt is not effectiveAt.
    const snapshot = JSON.stringify(dynamic, (key, value) => key === "updatedAt" ? undefined : value);
    map.meta = { status: dynamic.length === 0 ? "fallback" : dynamicResult.servedFrom === "baseline" ? "baseline" : "dynamic",
      snapshotId: createHash("sha256").update(snapshot || "[]").digest("hex"),
      fetchedAt: dynamic.map((e) => e.updatedAt).filter(Boolean).sort().at(-1) ?? null, effectiveAt: null };
    return map;
  } catch {
    console.error("loadPricingMap: dynamic pricing unavailable");
    const map = getDefaultPricingMap();
    map.meta = { status: "fallback", snapshotId: createHash("sha256").update(JSON.stringify(map)).digest("hex"), fetchedAt: null, effectiveAt: null };
    return map;
  }
}

export async function loadPricingMap(db: PricingMapDb): Promise<PricingMap> {
  if (cached && isFresh(cached)) return cached.map;
  inflight ??= loadPricingMapUncached(db).then((map) => {
    cached = { map, at: Date.now() };
    inflight = null;
    return map;
  });
  return inflight;
}
