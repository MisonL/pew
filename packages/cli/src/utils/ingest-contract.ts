/**
 * Client-side mirror of the token/session ingest contract.
 *
 * `packages/core/src/validation.ts` is the authority, but `@pew/core` is a
 * type-only devDependency here (the published CLI cannot depend on it), so the
 * checks are restated. They must agree with the server: a record this accepts
 * that the server rejects fails its whole batch with 400, and a 4xx never
 * advances the upload offset — one bad record then blocks the queue forever.
 * `__tests__/ingest-contract.test.ts` pins the agreement against the core
 * validators, so a drift on either side fails the suite.
 */

/** Active plus retired identities (core SOURCES ∪ RETIRED_SOURCES). */
const VALID_SOURCES = new Set([
  "antigravity", "claude-code", "codex", "copilot-cli", "grok", "hermes",
  "opencode", "openclaw", "pi",
  "gemini-cli", "kosmos", "omp", "pmstudio", "vscode-copilot", "zcode",
]);

const SESSION_KINDS = new Set(["human", "automated"]);

const MAX_STRING_LENGTH = 1024;
const MAX_RECORD_TOKENS = 1_000_000_000;
const MAX_RECORD_MESSAGES = 100_000_000;
const MAX_SESSION_DURATION_SECONDS = 315_576_000;

const ISO_STRICT_RE =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/**
 * Valid ISO 8601 instant, mirroring core `isValidISODate`.
 *
 * The day-of-month check is not redundant: `Date.parse("2026-02-30T…")` rolls
 * over to March 2 instead of failing, so a typo would silently shift by days.
 */
export function isValidIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_STRICT_RE.test(value)) return false;
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})/.exec(value) as RegExpExecArray;
  if (Number(day) > daysInMonth(Number(year), Number(month))) return false;
  return Number.isFinite(Date.parse(value));
}

const nonEmpty = (v: unknown): boolean =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_STRING_LENGTH;
const nullable = (v: unknown): boolean =>
  v === null || (typeof v === "string" && v.length <= MAX_STRING_LENGTH);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Reason a token queue record cannot be uploaded, or null when it can.
 *
 * `index` is dropped from core's `record[N]:` prefix: the caller reports the
 * offending record by queue position in its own message.
 */
export function tokenRecordRejection(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return "record is not an object";
  const r = record as Record<string, unknown>;
  if (typeof r.source !== "string" || !VALID_SOURCES.has(r.source)) {
    return "invalid source";
  }
  if (!nonEmpty(r.model)) return "model is required";
  if (!isValidIsoInstant(r.hour_start)) return "invalid hour_start format";
  if (r.device_id !== undefined && !nonEmpty(r.device_id)) return "device_id must be a non-empty string";
  const fields = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ] as const;
  for (const field of fields) {
    if (!count(r[field]) || r[field] > MAX_RECORD_TOKENS) {
      return `${field} must be a non-negative integer at most ${MAX_RECORD_TOKENS}`;
    }
  }
  const components = fields
    .slice(0, 4)
    .reduce((sum, field) => sum + (r[field] as number), 0);
  if (r.total_tokens !== components) {
    return "total_tokens must equal the sum of its components";
  }
  return null;
}

/** Reason a session queue record cannot be uploaded, or null when it can. */
export function sessionRecordRejection(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return "record is not an object";
  const r = record as Record<string, unknown>;
  if (!nonEmpty(r.session_key)) return "session_key is required";
  if (typeof r.source !== "string" || !VALID_SOURCES.has(r.source)) return "invalid source";
  if (typeof r.kind !== "string" || !SESSION_KINDS.has(r.kind)) return "invalid kind";
  for (const field of ["started_at", "last_message_at", "snapshot_at"] as const) {
    if (!isValidIsoInstant(r[field])) return `invalid ${field} format`;
  }
  for (const field of [
    "duration_seconds",
    "user_messages",
    "assistant_messages",
    "total_messages",
  ] as const) {
    const max = field === "duration_seconds" ? MAX_SESSION_DURATION_SECONDS : MAX_RECORD_MESSAGES;
    if (!count(r[field]) || r[field] > max) {
      return `${field} must be a non-negative integer at most ${max}`;
    }
  }
  if (!nullable(r.project_ref)) return "project_ref must be a string or null";
  if (!nullable(r.model)) return "model must be a string or null";
  return null;
}

// ---------------------------------------------------------------------------
// Usage evidence
// ---------------------------------------------------------------------------

const EVIDENCE_RECORD_KEYS = new Set(["source", "model", "device_id", "timestamp", "hour_start", "input_tokens",
  "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "evidence"]);
const EVIDENCE_KEYS = new Set(["eventId", "groupId", "callType", "origin", "provider", "granularity",
  "timePrecision", "intervalStart", "intervalEnd", "callCount", "snapshotSeq"]);
const CALL_TYPES = new Set(["compaction", "background_review", "approval", "compression", "title_generation", "vision", "auxiliary"]);
const ORIGINS = new Set(["pi-session", "hermes-review-log", "hermes-aux-ledger", "hermes-acp-ledger"]);
const PRECISIONS = new Set(["exact", "interval", "session-start", "unattributed"]);
const label = (v: unknown): boolean =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/+:-]{0,127}$/.test(v) &&
  !/^(?:sk-|sk_|pk_|Bearer|eyJ)/i.test(v) && !v.includes("://");
const isHash = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/**
 * Reason an evidence record cannot be uploaded, or null when it can.
 *
 * Usage evidence had no local filter at all: anything in the ledger was sent,
 * and the stage has no revision-ack protocol, so a record the server rejects
 * with 400 does not advance the offset — one bad record blocked the evidence
 * queue and every accounting annotation behind it, permanently (the ledger
 * deliberately survives `pew reset`). The numeric caps are the reachable half
 * of that contract: the projection only guarantees safe integers, while the
 * server additionally bounds each counter and `callCount`.
 */
export function evidenceRecordRejection(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return "record is not an object";
  const r = record as Record<string, unknown>;
  if (Object.keys(r).length !== EVIDENCE_RECORD_KEYS.size || Object.keys(r).some((k) => !EVIDENCE_RECORD_KEYS.has(k))) {
    return "unexpected usage evidence fields";
  }
  if (r.source !== "pi" && r.source !== "hermes") return "invalid source";
  if (!label(r.model)) return "model must be a usage label";
  if (typeof r.device_id !== "string" || !/^[\w.-]{1,128}$/.test(r.device_id)) return "invalid device_id";
  const tokenIssue = tokenRecordRejection(r);
  if (tokenIssue !== null) return tokenIssue;
  if (!isValidIsoInstant(r.timestamp)) return "invalid timestamp format";
  const time = Date.parse(r.timestamp as string);
  if (r.timestamp !== new Date(time).toISOString() ||
    r.hour_start !== new Date(Math.floor(time / 1_800_000) * 1_800_000).toISOString()) {
    return "timestamp and hour_start must be canonical";
  }
  const e = r.evidence;
  if (!e || typeof e !== "object" || Array.isArray(e)) return "evidence is required";
  const ev = e as Record<string, unknown>;
  if (Object.keys(ev).length !== EVIDENCE_KEYS.size || Object.keys(ev).some((k) => !EVIDENCE_KEYS.has(k))) {
    return "unexpected usage evidence fields";
  }
  if (!isHash(ev.eventId) || !isHash(ev.groupId) || !label(ev.provider)) return "invalid event identity";
  if (!CALL_TYPES.has(ev.callType as string) || !ORIGINS.has(ev.origin as string) ||
    !PRECISIONS.has(ev.timePrecision as string) || !["call", "operation", "session"].includes(ev.granularity as string)) {
    return "invalid usage evidence kind";
  }
  if (!count(ev.snapshotSeq) || ev.snapshotSeq === 0) return "invalid snapshot sequence";
  if (ev.callCount !== null && (!count(ev.callCount) || (ev.callCount as number) > MAX_RECORD_MESSAGES)) {
    return `callCount must be a non-negative integer at most ${MAX_RECORD_MESSAGES}`;
  }
  const piKind = ev.callType === "compaction" && ev.origin === "pi-session";
  if ((r.source === "pi") !== piKind) return "source does not match its call kind";
  if (r.source === "hermes" && (ev.callType === "compaction" || ev.origin === "pi-session")) {
    return "source does not match its call kind";
  }
  for (const field of ["intervalStart", "intervalEnd"] as const) {
    const value = ev[field];
    if (value === null) continue;
    if (typeof value !== "string" || !isValidIsoInstant(value) || value !== new Date(Date.parse(value)).toISOString()) {
      return "interval bounds must be canonical";
    }
  }
  if (ev.intervalStart !== null && ev.intervalEnd !== null &&
    Date.parse(ev.intervalStart as string) > Date.parse(ev.intervalEnd as string)) {
    return "interval_start must not be after interval_end";
  }
  return null;
}
