/**
 * Largest epoch ms the ingest contract can represent: 9999-12-31T23:59:59.999Z.
 * `new Date(1e20).toISOString()` throws RangeError outright, and anything past
 * this bound serializes to a year the server's ISO validator rejects.
 */
export const MAX_EPOCH_MS = 253_402_300_799_999;

/**
 * Coerce an epoch value to milliseconds.
 * Values < 1e12 are treated as seconds and multiplied by 1000.
 *
 * Returns 0 for anything that cannot be a real date: `new Date(1e20)
 * .toISOString()` throws RangeError, and an epoch that overflows the Date
 * range would otherwise crash the whole source collector.
 */
export function coerceEpochMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ms = n < 1e12 ? n * 1000 : n;
  if (!Number.isFinite(ms) || ms > MAX_EPOCH_MS) return 0;
  return Math.floor(ms);
}
