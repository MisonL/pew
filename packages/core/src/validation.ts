/**
 * Shared runtime validation for ingest records.
 *
 * Used by both Next.js API routes and Cloudflare Worker
 * for defense-in-depth validation.
 */

import type { SessionKind, Source } from "./types.js";
import {
  MAX_STRING_LENGTH,
  MAX_RECORD_TOKENS,
  MAX_RECORD_MESSAGES,
  MAX_SESSION_DURATION_SECONDS,
  VALID_SESSION_KINDS,
  VALID_SOURCES,
  RETIRED_SOURCES,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

/** Check active or historical identities for stored records. */
export function isValidSource(s: unknown): s is Source {
  return typeof s === "string" && VALID_SOURCES.has(s);
}

export function isRetiredSourceRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = (value as Record<string, unknown>).source;
  return typeof source === "string" && RETIRED_SOURCES.some((retired) => retired === source);
}

/** Check if value is a valid SessionKind */
export function isValidSessionKind(k: unknown): k is SessionKind {
  return typeof k === "string" && VALID_SESSION_KINDS.has(k);
}

/**
 * Validate ISO 8601 date string format with semantic checks.
 *
 * Accepts: "2026-03-07T10:30:00Z", "2026-03-07T10:30:00.000Z",
 *          "2026-03-07T10:30:00+08:00"
 * Rejects: "9999-99-99T99:99:99", trailing garbage, non-dates
 */
export function isValidISODate(s: unknown): boolean {
  if (typeof s !== "string") return false;

  // Full ISO 8601 with anchored regex:
  // YYYY-MM-DDThh:mm:ss followed by optional fractional seconds,
  // then required timezone (Z or +/-HH:MM)
  const ISO_STRICT_RE =
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

  if (!ISO_STRICT_RE.test(s)) return false;

  // Final semantic checks. Date.parse rolls an impossible calendar day over
  // ("2026-02-30" becomes 2026-03-02), so the day-of-month is checked against
  // the month's real length first; otherwise a typo would be silently shifted
  // by days once the value is canonicalized.
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) as RegExpExecArray;
  if (Number(day) > daysInMonth(Number(year), Number(month))) return false;

  const ts = Date.parse(s);
  return Number.isFinite(ts);
}

/** Days in a Gregorian month (1-based month). */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/** Check if value is a non-negative integer */
export function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Normalize an ISO 8601 instant to its canonical UTC spelling.
 *
 * Returns `null` for anything `isValidISODate` rejects. Every persisted
 * timestamp is compared and grouped as a raw string (the `usage_records`
 * unique key, `excluded.snapshot_at >= session_records.snapshot_at`, the
 * `hour_start` range predicates, `date(hour_start)` bucketing), and ISO
 * variants do not sort consistently: `"10:00:00Z"` and `"10:00:00.000Z"`
 * are different rows for the same hour, while `"...15:00:00+08:00"` sorts
 * above `"...12:00:00Z"` even though it is five hours earlier. Collapsing
 * every accepted form to `toISOString()` output keeps one instant equal to
 * one string, which is what makes the string comparisons correct.
 *
 * Sub-millisecond precision is truncated because JavaScript dates carry
 * milliseconds; sources such as Grok session summaries emit microseconds.
 */
export function canonicalUtcTimestamp(s: unknown): string | null {
  if (!isValidISODate(s)) return null;
  return new Date(s as string).toISOString();
}

/**
 * Check if value is a non-empty string within length limit.
 * @param maxLength - max allowed length (default MAX_STRING_LENGTH)
 */
export function isNonEmptyString(
  s: unknown,
  maxLength: number = MAX_STRING_LENGTH,
): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= maxLength;
}

/**
 * Check if value is null or a string within length limit.
 * @param maxLength - max allowed length (default MAX_STRING_LENGTH)
 */
export function isNullableString(
  s: unknown,
  maxLength: number = MAX_STRING_LENGTH,
): s is string | null {
  if (s === null) return true;
  return typeof s === "string" && s.length <= maxLength;
}

// ---------------------------------------------------------------------------
// Ingest record types (runtime, shared between Next.js and Worker)
// ---------------------------------------------------------------------------

/** Token ingest record (snake_case, matching DB schema) */
export interface IngestRecord {
  source: string;
  model: string;
  hour_start: string;
  /** Stable device identifier (optional for backward compat — old CLIs omit it) */
  device_id?: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

/** Session ingest record (snake_case, matching DB schema) */
export interface SessionIngestRecord {
  session_key: string;
  source: string;
  kind: string;
  started_at: string;
  last_message_at: string;
  duration_seconds: number;
  user_messages: number;
  assistant_messages: number;
  total_messages: number;
  project_ref: string | null;
  model: string | null;
  snapshot_at: string;
}

/** Payload sent from Next.js to Worker for token ingest */
export interface IngestRequest {
  userId: string;
  records: IngestRecord[];
}

/** Payload sent from Next.js to Worker for session ingest */
export interface SessionIngestRequest {
  userId: string;
  records: SessionIngestRecord[];
}

// ---------------------------------------------------------------------------
// Validation result type
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { valid: true; record: T }
  | { valid: false; error: string };

// ---------------------------------------------------------------------------
// Record validators (type-safe narrowing)
// ---------------------------------------------------------------------------

/**
 * Validate a single token ingest record.
 * Returns a discriminated union: { valid: true, record } or { valid: false, error }.
 */
export function validateIngestRecord(
  r: unknown,
  index: number,
): ValidationResult<IngestRecord> {
  if (typeof r !== "object" || r === null) {
    return { valid: false, error: `record[${index}]: must be an object` };
  }

  const rec = r as Record<string, unknown>;

  if (!isValidSource(rec.source)) {
    return {
      valid: false,
      error: `record[${index}]: invalid source "${String(rec.source)}"`,
    };
  }
  if (!isNonEmptyString(rec.model)) {
    return { valid: false, error: `record[${index}]: model is required (non-empty string, max ${MAX_STRING_LENGTH} chars)` };
  }
  const hourStart = canonicalUtcTimestamp(rec.hour_start);
  if (hourStart === null) {
    return { valid: false, error: `record[${index}]: invalid hour_start format (ISO 8601 required)` };
  }

  // Optional device_id (backward compat: old CLIs don't send it)
  if (rec.device_id !== undefined && !isNonEmptyString(rec.device_id)) {
    return { valid: false, error: `record[${index}]: device_id must be a non-empty string if provided` };
  }

  const tokenFields = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ] as const;

  for (const field of tokenFields) {
    if (!isNonNegativeInteger(rec[field]) || rec[field] > MAX_RECORD_TOKENS) {
      return {
        valid: false,
        error: `record[${index}]: ${field} must be a non-negative integer at most ${MAX_RECORD_TOKENS}`,
      };
    }
  }

  // usage_evidence and usage_details both enforce this in the schema; without
  // it here the legacy usage_records table could store a total that disagrees
  // with its own component breakdown, making SUM(total_tokens) rankings and
  // per-field charts describe different amounts.
  const components =
    (rec.input_tokens as number) + (rec.cached_input_tokens as number) +
    (rec.output_tokens as number) + (rec.reasoning_output_tokens as number);
  if (rec.total_tokens !== components) {
    return {
      valid: false,
      error: `record[${index}]: total_tokens must equal input_tokens + cached_input_tokens + output_tokens + reasoning_output_tokens`,
    };
  }

  const record = rec as unknown as IngestRecord;
  return { valid: true, record: {
    source: record.source, model: record.model, hour_start: hourStart,
    ...(record.device_id !== undefined ? { device_id: record.device_id } : {}),
    input_tokens: record.input_tokens, cached_input_tokens: record.cached_input_tokens,
    output_tokens: record.output_tokens, reasoning_output_tokens: record.reasoning_output_tokens,
    total_tokens: record.total_tokens,
  } };
}

/**
 * Validate a single session ingest record.
 * Returns a discriminated union: { valid: true, record } or { valid: false, error }.
 */
export function validateSessionIngestRecord(
  r: unknown,
  index: number,
): ValidationResult<SessionIngestRecord> {
  if (typeof r !== "object" || r === null) {
    return { valid: false, error: `record[${index}]: must be an object` };
  }

  const rec = r as Record<string, unknown>;

  if (!isNonEmptyString(rec.session_key)) {
    return { valid: false, error: `record[${index}]: session_key is required` };
  }
  if (!isValidSource(rec.source)) {
    return {
      valid: false,
      error: `record[${index}]: invalid source "${String(rec.source)}"`,
    };
  }
  if (!isValidSessionKind(rec.kind)) {
    return {
      valid: false,
      error: `record[${index}]: invalid kind "${String(rec.kind)}"`,
    };
  }

  // Date fields — canonicalized so one instant is one string. `snapshot_at`
  // is compared lexicographically in the session UPSERT guard, so a
  // non-canonical form must not reach the database.
  const startedAt = canonicalUtcTimestamp(rec.started_at);
  if (startedAt === null) {
    return { valid: false, error: `record[${index}]: invalid started_at format` };
  }
  const lastMessageAt = canonicalUtcTimestamp(rec.last_message_at);
  if (lastMessageAt === null) {
    return { valid: false, error: `record[${index}]: invalid last_message_at format` };
  }
  const snapshotAt = canonicalUtcTimestamp(rec.snapshot_at);
  if (snapshotAt === null) {
    return { valid: false, error: `record[${index}]: invalid snapshot_at format` };
  }

  // Non-negative integer fields
  const intFields = [
    "duration_seconds",
    "user_messages",
    "assistant_messages",
    "total_messages",
  ] as const;

  for (const field of intFields) {
    const max = field === "duration_seconds" ? MAX_SESSION_DURATION_SECONDS : MAX_RECORD_MESSAGES;
    if (!isNonNegativeInteger(rec[field]) || rec[field] > max) {
      return {
        valid: false,
        error: `record[${index}]: ${field} must be a non-negative integer at most ${max}`,
      };
    }
  }

  // Nullable string fields
  if (!isNullableString(rec.project_ref)) {
    return { valid: false, error: `record[${index}]: project_ref must be a string or null` };
  }
  if (!isNullableString(rec.model)) {
    return { valid: false, error: `record[${index}]: model must be a string or null` };
  }

  const record = rec as unknown as SessionIngestRecord;
  return { valid: true, record: {
    session_key: record.session_key, source: record.source, kind: record.kind,
    started_at: startedAt, last_message_at: lastMessageAt,
    duration_seconds: record.duration_seconds, user_messages: record.user_messages,
    assistant_messages: record.assistant_messages, total_messages: record.total_messages,
    project_ref: record.project_ref, model: record.model, snapshot_at: snapshotAt,
  } };
}
