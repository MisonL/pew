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
/**
 * Parse a timestamp written by an AI-tool log into epoch ms.
 *
 * ISO strings without a zone are read as UTC: the project stores UTC
 * everywhere, and letting the host timezone decide made the same log line
 * land in different hour buckets on different machines. Calendar fields are
 * validated first because `Date.parse` silently rolls2026-02-30 over to
 * March2 instead of rejecting it.
 *
 * Returns null when the value is not a calendar instant this contract can
 * represent (bad shape, impossible date, expanded year).
 */
const SOURCE_INSTANT_RE =
 /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?([Zz]|[+-]\d{2}:?\d{2})?$/;

function utcDaysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

export function parseSourceInstant(value: string): number | null {
  if (typeof value !== "string") return null;
  const match = SOURCE_INSTANT_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = match[4] === undefined ? 0 : Number(match[4]);
  const minutes = match[5] === undefined ? 0 : Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > utcDaysInMonth(year, month)) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const zone = match[8];
  if (zone !== undefined) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  const fraction = `${match[7] ?? ""}000`;
  const millis = Number(fraction.slice(0,3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hours, minutes, seconds, millis);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}
export function coerceEpochMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ms = n < 1e12 ? n * 1000 : n;
  if (!Number.isFinite(ms) || ms > MAX_EPOCH_MS) return 0;
  return Math.floor(ms);
}
