/**
 * URL builder for GET /api/usage, extracted from useUsageData so the
 * window math is testable without a render harness.
 *
 * The `days` fallback must send an exact instant, not a bare UTC date:
 * the API reads a bare date as UTC midnight, so east of UTC the oldest
 * local day is partially outside the window while the client buckets by
 * local day — the first WoW/MoM point is short and the percentage it
 * feeds is diluted. trailingLocalDays() is the repo's existing fix for
 * exactly this (hourly-usage and the admin compare page pass explicit
 * instants); a caller that only knows `days` was left out.
 */
import { trailingLocalDays } from "./date-helpers";

export interface UsageUrlInput {
  days: number;
  /** Explicit instant/date params win over the days window. */
  from?: string;
  to?: string;
  granularity: "day" | "half-hour";
  /** minutes behind UTC (Date#getTimezoneOffset sign) */
  tzOffset: number;
  source?: string;
  deviceId?: string;
  includeAccounting?: boolean | "project";
  summaryOnly?: boolean;
}

export function buildUsageUrl(input: UsageUrlInput): string {
  let fromStr: string;
  let toStr: string | undefined = input.to;
  if (input.from) {
    fromStr = input.from;
  } else {
    const window = trailingLocalDays(input.days, input.tzOffset);
    fromStr = window.from;
    if (!toStr) toStr = window.to;
  }

  const params = new URLSearchParams({ from: fromStr, granularity: input.granularity });
  if (toStr) params.set("to", toStr);
  if (input.source) params.set("source", input.source);
  if (input.deviceId) params.set("deviceId", input.deviceId);
  if (input.granularity === "day") {
    params.set("tzOffset", String(input.tzOffset));
  }
  if (input.includeAccounting === false) params.set("includeAccounting", "0");
  else if (input.includeAccounting === "project") params.set("includeAccounting", "project");
  if (input.summaryOnly) params.set("summaryOnly", "1");

  return `/api/usage?${params.toString()}`;
}
