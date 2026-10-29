import { useMemo } from "react";
import type { UsageRow, DailyPoint, SourceAggregate, ModelAggregate } from "@/lib/usage-transforms";
import {
  toDailyPoints,
  toSourceAggregates,
  toModelAggregates,
  sourceLabel,
} from "@/lib/usage-transforms";

interface UseDerivedUsageDataResult {
  daily: DailyPoint[];
  sources: SourceAggregate[];
  models: ModelAggregate[];
}

/**
 * Shared hook that memoizes daily, source, and model aggregations from usage
 * records. Used by both `useUsageData` and `useUserProfile` to avoid
 * duplicating the same derived-data logic.
 *
 * Pass `enabled: false` to skip the three passes entirely. Pages that chart
 * raw records (sessions, hourly pattern, devices, daily-usage) never read the
 * aggregates, and each pass walks every row and every annotation.
 */
export function useDerivedUsageData(
  records: UsageRow[] | null,
  tzOffset: number,
  enabled = true,
): UseDerivedUsageDataResult {
  const daily = useMemo(
    () => (enabled && records ? toDailyPoints(records, tzOffset) : []),
    [records, tzOffset, enabled],
  );

  const sources = useMemo(
    () =>
      enabled && records
        ? toSourceAggregates(records).map((s) => ({
            ...s,
            label: sourceLabel(s.label),
          }))
        : [],
    [records, enabled],
  );

  const models = useMemo(
    () => (enabled && records ? toModelAggregates(records) : []),
    [records, enabled],
  );

  return { daily, sources, models };
}
