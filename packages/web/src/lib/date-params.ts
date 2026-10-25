/**
 * Shared parsing for the `from`/`to` query parameters of the usage routes.
 *
 * The previous per-route regex was `/^\d{4}-\d{2}-\d{2}/`: unanchored, so
 * "2026-03-99", "2026-13-45" and "2026-03-13garbage" all passed and then threw
 * a RangeError out of `toISOString()` — a 500 for what is plainly a bad
 * parameter. Validation and conversion now live together so a route cannot
 * accept a value it cannot parse.
 */

/**
 * A bare date ("2026-03-13") or a full ISO instant.
 *
 * Anchored at both ends; the date part is additionally checked against the
 * month's real length because `Date.parse` rolls "2026-02-30" over to March 2
 * instead of failing.
 */
const DATE_PARAM_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/** True when `value` is a parseable date or ISO instant accepted by the API. */
export function isDateParam(value: string): boolean {
  const match = DATE_PARAM_RE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match as RegExpExecArray;
  if (Number(day) > daysInMonth(Number(year), Number(month))) return false;
  return Number.isFinite(Date.parse(value));
}

/** Parse a validated date parameter to a UTC ISO string. */
export function dateParamToIso(value: string): string {
  return new Date(value).toISOString();
}

/** True for a bare "YYYY-MM-DD" (no time component), which is inclusive. */
export function isBareDate(value: string): boolean {
  return value.length === 10;
}
