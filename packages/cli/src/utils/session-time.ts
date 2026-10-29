/**
 * Canonical instants for session snapshots.
 *
 * Session logs carry whatever their tool wrote: RFC 3339 with a numeric
 * offset, offset-less local time, a date-only string, or the odd corrupt
 * value. The ingest contract accepts exactly `Date.prototype.toISOString()`
 * output — the server compares `started_at` / `last_message_at` /
 * `snapshot_at` as raw strings — and rejects the whole batch when one record
 * is off-contract. A 4xx never advances the upload offset, so a single bad
 * snapshot wedges the session queue permanently.
 *
 * Mirrors `canonicalUtcTimestamp` in `packages/core/src/validation.ts`; the
 * CLI cannot import it at runtime because `@pew/core` is a type-only
 * devDependency (see AGENTS.md).
 */

import { isValidIsoInstant } from "./ingest-contract.js";

/** Ingest contract cap for `duration_seconds` (see core MAX_SESSION_DURATION_SECONDS). */
export const MAX_SESSION_DURATION_SECONDS = 315_576_000;

/**
 * Canonical UTC spelling of an instant, or null when the value is not one.
 *
 * The zone designator is required, exactly as in the server contract: an
 * offset-less `2026-03-07T10:15:30` would otherwise be read in whatever
 * timezone the syncing machine happens to use, and the same log would land in
 * a different hour bucket on every machine.
 */
export function canonicalInstant(value: unknown): string | null {
  if (!isValidIsoInstant(value)) return null;
  return new Date(value).toISOString();
}

/** Earliest and latest instant seen in one file. */
export interface InstantBounds {
  min: string | null;
  max: string | null;
}

/**
 * Track the earliest and latest instant seen; invalid values are ignored.
 *
 * Comparison is lexicographic on canonical strings on purpose: they all carry
 * the same width and the `Z` suffix, so byte order is chronological order —
 * which raw log strings with mixed offsets are not.
 */
export function trackInstant(bounds: InstantBounds, value: unknown): void {
  const instant = canonicalInstant(value);
  if (instant === null) return;
  if (bounds.min === null || instant < bounds.min) bounds.min = instant;
  if (bounds.max === null || instant > bounds.max) bounds.max = instant;
}

/**
 * Whole seconds between two canonical instants, clamped to the ingest cap.
 *
 * Returns 0 for an unparseable or inverted pair so a corrupt pair of lines
 * cannot emit a NaN that serializes to `null` and trips the server validator.
 */
export function durationSeconds(startedAt: string, lastMessageAt: string): number {
  const ms = Date.parse(lastMessageAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(Math.floor(ms / 1000), MAX_SESSION_DURATION_SECONDS);
}
