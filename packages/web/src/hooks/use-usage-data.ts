"use client";

import { useMemo } from "react";
import { useDerivedUsageData } from "@/hooks/use-derived-usage-data";

import type { UsageRow, UsageSummary } from "@/lib/usage-transforms";
import type { DailyPoint, SourceAggregate, ModelAggregate } from "@/lib/usage-transforms";
import { useFetchData } from "@/hooks/use-fetch-data";
import { useTzOffset } from "@/hooks/use-tz-offset";

// ---------------------------------------------------------------------------
// Re-export types and helpers for backward compatibility
// ---------------------------------------------------------------------------

export type { UsageRow, UsageSummary, DailyPoint, SourceAggregate, HeatmapPoint, ModelAggregate } from "@/lib/usage-transforms";
export { toDailyPoints, toSourceAggregates, toHeatmapData, toModelAggregates, sourceLabel } from "@/lib/usage-transforms";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageData {
  records: UsageRow[];
  summary: UsageSummary;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseUsageDataOptions {
  /** Number of days to look back (default 30). Ignored when `from` is set. */
  days?: number;
  /** Explicit start date (ISO date string, e.g. "2026-01-01") */
  from?: string;
  /** Explicit end date (ISO date string). Defaults to today. */
  to?: string;
  /** Source filter (optional) */
  source?: string;
  /** Device filter (optional) */
  deviceId?: string;
  /** Granularity for the API query (default "day"). Use "half-hour" for time-of-day analysis. */
  granularity?: "day" | "half-hour";
  /**
   * Skip the request entirely (SWR key null). Callers that can derive the
   * same window from an already-fetched superset use this to avoid a
   * duplicate multi-MB download.
   */
  enabled?: boolean;
  /**
   * false drops the per-row accounting annotations and keeps the raw legacy
   * counters; "project" also returns the counters already projected through
   * displayCounters(), for charts that rank by accountedTotal(). Annotations
   * are ~98% of a large response.
   */
  includeAccounting?: boolean | "project";
  /** Fetch the summary only, with an empty record list. */
  summaryOnly?: boolean;
  /**
   * Compute the daily/source/model aggregates. Default true; pass false on
   * pages that read `data.records` directly, where each pass walks every row
   * and annotation for a result nobody consumes.
   */
  derived?: boolean;
}

interface UseUsageDataResult {
  data: UsageData | null;
  daily: DailyPoint[];
  sources: SourceAggregate[];
  models: ModelAggregate[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useUsageData(
  options: UseUsageDataOptions = {}
): UseUsageDataResult {
  const { days = 30, from: fromDate, to: toDate, source, deviceId, granularity = "day", enabled = true,
    includeAccounting = true, summaryOnly = false, derived = true } = options;

  // Frozen per mount — acceptable; page refresh handles DST changes
  const tzOffset = useTzOffset();

  const url = useMemo(() => {
    // When explicit `from` is provided, use it directly; otherwise compute from `days`
    let fromStr: string;
    if (fromDate) {
      fromStr = fromDate;
    } else {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - days);
      fromStr = d.toISOString().slice(0, 10);
    }

    const params = new URLSearchParams({
      from: fromStr,
      granularity,
    });
    if (toDate) params.set("to", toDate);
    if (source) params.set("source", source);
    if (deviceId) params.set("deviceId", deviceId);
    if (granularity === "day") {
      params.set("tzOffset", String(tzOffset));
    }
    if (includeAccounting === false) params.set("includeAccounting", "0");
    else if (includeAccounting === "project") params.set("includeAccounting", "project");
    if (summaryOnly) params.set("summaryOnly", "1");

    return `/api/usage?${params.toString()}`;
  }, [days, fromDate, toDate, source, deviceId, granularity, tzOffset, includeAccounting, summaryOnly]);

  const { data, loading, error, refetch } = useFetchData<UsageData>(url, { enabled });

  // Memoize derived data to avoid recalculation on every render
  const { daily, sources, models } = useDerivedUsageData(data?.records ?? null, tzOffset, derived);

  return { data, daily, sources, models, loading, error, refetch };
}
