/**
 * Guards for filter parameters that go straight into SQL binds.
 *
 * A truthiness check (`if (!req.fromDate)`) only rules out falsy values: a
 * number or object passed it, reached D1's bind, and either threw (500 for
 * what is the caller's input error) or compared as a non-TEXT type against a
 * TEXT column — SQLite finds a number "never equal" to a string, silently
 * emptying a filter the caller believes it applied. The web callers all
 * normalize to full ISO before the RPC (`dateParamToIso`, `toISOString`), so
 * the strict shape is checked here as well as the type.
 */

import { MAX_STRING_LENGTH, isValidISODate } from "@pew/core";

const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A window bound: a full ISO 8601 timestamp, or a bare `YYYY-MM-DD` day.
 * Both sort correctly against the canonical stored timestamps in a text
 * comparison; anything else would either fail the bind or compare as a
 * different type and match nothing.
 */
export function isWindowDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (isValidISODate(value)) return true;
  const bare = BARE_DATE_RE.exec(value);
  if (!bare) return false;
  // Same calendar check as isValidISODate: Date.parse rolls "2026-02-30"
  // over to March 2, which would silently shift the window.
  const [, year, month, day] = bare;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
}

/**
 * An optional string filter: absent or empty means "no filter", anything
 * present must be a string within the same bound the stored values observe.
 */
export function isValidOptionalFilter(value: unknown): value is string | undefined {
  return value === undefined || value === null || value === "" ||
    (typeof value === "string" && value.length <= MAX_STRING_LENGTH);
}
