"use client";

import {
  type PricingMap,
  getDefaultPricingMap,
  lookupPricing,
  estimateCost,
  formatCost,
} from "@/lib/pricing";
import { useFetchData } from "@/hooks/use-fetch-data";

interface UsePricingMapResult {
  /** Merged pricing map (DB overrides + static defaults). Falls back to static defaults while loading. */
  pricingMap: PricingMap;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Degraded map for a failed /api/pricing fetch.
 *
 * The server's own degraded map (load-pricing-map.ts catch path) carries
 * `meta.status = "fallback"`, and estimateUsageCost's completeness check keys
 * off it. Mirroring that here keeps the client and server degraded snapshots
 * identical, so any consumer that reads `pricingMap.meta?.status` cannot see
 * a failed fetch as a real snapshot. While merely loading we still return the
 * plain defaults: the loading flag already renders "Prices are loading.".
 */
function failedPricingMap(): PricingMap {
  return {
    ...getDefaultPricingMap(),
    meta: {
      status: "fallback",
      snapshotId: "",
      fetchedAt: null,
      effectiveAt: null,
    },
  };
}

/**
 * Fetch the merged pricing map from /api/pricing.
 * Returns static defaults immediately while loading so cost calculations never block.
 */
export function usePricingMap(): UsePricingMapResult {
  const { data, loading, error, refetch } = useFetchData<PricingMap>("/api/pricing");

  return {
    pricingMap: data ?? (error ? failedPricingMap() : getDefaultPricingMap()),
    loading,
    error,
    refetch,
  };
}

// Re-export helpers so pages can import everything from one place
export { lookupPricing, estimateCost, formatCost };
export type { PricingMap };
