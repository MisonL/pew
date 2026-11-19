/**
 * Shape predicates for persisted state files.
 *
 * A state file is written by pew itself, but it can still arrive damaged: a
 * hand edit, a restored backup, a half-written file from an older version.
 * `JSON.parse` accepting it says nothing about whether its fields have the
 * types the consumers assume.
 */

/** A JSON object — not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}