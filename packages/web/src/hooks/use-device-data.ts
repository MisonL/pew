"use client";

import { useMemo } from "react";
import type { ByDeviceResponse } from "@pew/core";
import { useFetchData } from "@/hooks/use-fetch-data";
import { useTzOffset } from "@/hooks/use-tz-offset";
import { toDeviceDisplayData } from "@/lib/device-helpers";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseDeviceDataOptions {
  /** Explicit start date (ISO date string, e.g. "2026-01-01") */
  from?: string;
  /** Explicit end date (ISO date string). Defaults to today. */
  to?: string;
  /** Timeline granularity: "half-hour" or "day" (default: "day") */
  granularity?: "half-hour" | "day";
  /**
   * Fetch the per-(device,source,model) drill-down rows. Only /devices and
   * /hourly-usage read them; the dashboard breakdown charts use `devices` and
   * `timeline` only, so they pass false to skip ~1/3 of the payload.
   */
  includeDetails?: boolean;
}

interface UseDeviceDataResult {
  data: ByDeviceResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetch per-device usage analytics from GET /api/usage/by-device.
 * Same pattern as useUsageData.
 */
export function useDeviceData(
  options: UseDeviceDataOptions = {}
): UseDeviceDataResult {
  const { from: fromDate, to: toDate, granularity, includeDetails = true } = options;
  const tzOffset = useTzOffset();

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (granularity) params.set("granularity", granularity);
    if (!includeDetails) params.set("includeDetails", "0");
    params.set("tzOffset", String(tzOffset));

    const qs = params.toString();
    return `/api/usage/by-device${qs ? `?${qs}` : ""}`;
  }, [fromDate, toDate, granularity, includeDetails, tzOffset]);

  const result = useFetchData<ByDeviceResponse>(url);
  const data = useMemo(() => result.data ? toDeviceDisplayData(result.data) : null, [result.data]);
  return { ...result, data };
}
