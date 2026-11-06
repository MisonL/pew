/**
 * Clamp a caller-supplied pagination value to what SQLite will accept.
 *
 * The RPC body is JSON, so `limit`/`offset` can arrive fractional, negative,
 * NaN or as another type entirely. Binding any of those to LIMIT/OFFSET is not
 * harmless:
 *   - a fractional or non-numeric value makes SQLite answer "datatype
 *     mismatch" (verified with the sqlite3 CLI), which surfaced as a 500;
 *   - `LIMIT -1` (and any negative) means "no limit", silently dropping the
 *     cap instead of paging.
 * Truncating to an integer and clamping into [0, max] keeps both failure
 * modes off the request path.
 */
export function clampedLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

export function clampedOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(Math.trunc(value), 0);
}
