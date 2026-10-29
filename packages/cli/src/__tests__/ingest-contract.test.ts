import { describe, expect, it } from "vitest";
import {
  evidenceRecordRejection,
  isValidIsoInstant,
  sessionRecordRejection,
  tokenRecordRejection,
} from "../utils/ingest-contract.js";
import { toEvidenceRecord } from "../utils/usage-evidence.js";
import {
  validateEvidenceRecord,
  validateIngestRecord,
  validateSessionIngestRecord,
} from "@pew/core";
import type { ParsedDelta } from "../parsers/claude.js";

/**
 * The CLI restates the server contract locally because `@pew/core` is a
 * type-only devDependency of this package. These cases keep both copies in
 * lockstep: a record the mirror accepts while the server rejects it would
 * wedge the queue (a 4xx never advances the upload offset).
 */

const TOKEN = {
  source: "claude-code",
  model: "claude-sonnet-4",
  hour_start: "2026-03-07T10:30:00.000Z",
  device_id: "11111111-1111-4111-8111-111111111111",
  input_tokens: 10,
  cached_input_tokens: 20,
  output_tokens: 30,
  reasoning_output_tokens: 40,
  total_tokens: 100,
};

const SESSION = {
  session_key: "claude:ses-1",
  source: "claude-code",
  kind: "human",
  started_at: "2026-03-07T10:00:00.000Z",
  last_message_at: "2026-03-07T10:30:00.000Z",
  duration_seconds: 1800,
  user_messages: 2,
  assistant_messages: 3,
  total_messages: 5,
  project_ref: "0123456789abcdef",
  model: "claude-sonnet-4",
  snapshot_at: "2026-03-07T11:00:00.000Z",
};

describe("tokenRecordRejection agrees with validateIngestRecord", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["valid", TOKEN],
    ["retired source", { ...TOKEN, source: "gemini-cli" }],
    ["unknown source", { ...TOKEN, source: "not-a-tool" }],
    ["non-string source", { ...TOKEN, source: 42 }],
    ["empty model", { ...TOKEN, model: "" }],
    ["non-string model", { ...TOKEN, model: null }],
    ["model over the length cap", { ...TOKEN, model: "m".repeat(1025) }],
    ["missing hour_start", { ...TOKEN, hour_start: undefined }],
    ["non-ISO hour_start", { ...TOKEN, hour_start: "yesterday" }],
    ["offset hour_start", { ...TOKEN, hour_start: "2026-03-07T18:30:00+08:00" }],
    ["impossible calendar day", { ...TOKEN, hour_start: "2026-02-30T10:30:00.000Z" }],
    ["negative tokens", { ...TOKEN, input_tokens: -1, total_tokens: 89 }],
    ["fractional tokens", { ...TOKEN, input_tokens: 1.5, total_tokens: 91.5 }],
    ["token over the cap", { ...TOKEN, input_tokens: 1_000_000_001, total_tokens: 1_000_000_091 }],
    ["unsafe integer", { ...TOKEN, input_tokens: Number.MAX_VALUE, total_tokens: Number.MAX_VALUE }],
    ["total disagrees with components", { ...TOKEN, total_tokens: 99 }],
    ["empty device_id", { ...TOKEN, device_id: "" }],
    ["device_id omitted", { ...TOKEN, device_id: undefined }],
  ];

  it.each(cases)("%s", (_label, record) => {
    // `device_id: undefined` means "key absent" for both validators.
    const wire = Object.fromEntries(
      Object.entries(record).filter(([, value]) => value !== undefined),
    );
    expect(tokenRecordRejection(wire) === null).toBe(
      validateIngestRecord(wire, 0).valid,
    );
  });
});

describe("sessionRecordRejection agrees with validateSessionIngestRecord", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["valid", SESSION],
    ["empty session_key", { ...SESSION, session_key: "" }],
    ["unknown source", { ...SESSION, source: "not-a-tool" }],
    ["unknown kind", { ...SESSION, kind: "robot" }],
    ["non-ISO started_at", { ...SESSION, started_at: "March 7, 2026" }],
    ["impossible calendar day", { ...SESSION, started_at: "2026-04-31T10:00:00.000Z" }],
    ["missing snapshot_at", { ...SESSION, snapshot_at: null }],
    ["negative duration", { ...SESSION, duration_seconds: -1 }],
    ["fractional duration", { ...SESSION, duration_seconds: 12.5 }],
    ["duration over the cap", { ...SESSION, duration_seconds: 315_576_001 }],
    ["message count over the cap", { ...SESSION, total_messages: 100_000_001 }],
    ["project_ref not a string", { ...SESSION, project_ref: 12 }],
    ["project_ref over the length cap", { ...SESSION, project_ref: "p".repeat(1025) }],
    ["model null", { ...SESSION, model: null }],
    ["model over the length cap", { ...SESSION, model: "m".repeat(1025) }],
  ];

  it.each(cases)("%s", (_label, record) => {
    expect(sessionRecordRejection(record) === null).toBe(
      validateSessionIngestRecord(record, 0).valid,
    );
  });
});

/**
 * Usage evidence has two local gates, and both must agree with the server:
 * `toEvidenceRecord` projects a delta (throwing on what it cannot express),
 * and `evidenceRecordRejection` filters the ledger at upload time. A record
 * that survives both must be one the server accepts — otherwise a 400 blocks
 * the evidence queue, which `pew reset` deliberately does not clear.
 */
describe("usage evidence agrees with validateEvidenceRecord", () => {
  const DEVICE = "11111111-1111-4111-8111-111111111111";
  const evidenceDelta = (patch: Partial<ParsedDelta> = {}, evidencePatch: Record<string, unknown> = {}): ParsedDelta => ({
    source: "pi",
    model: "claude-sonnet-4",
    timestamp: "2026-03-07T10:05:00.000Z",
    tokens: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 40 },
    evidence: {
      eventId: "a".repeat(64), groupId: "b".repeat(64), callType: "compaction", origin: "pi-session",
      provider: "anthropic", granularity: "call", timePrecision: "exact",
      intervalStart: null, intervalEnd: null, callCount: null, snapshotSeq: 1,
      ...evidencePatch,
    },
    ...patch,
  } as ParsedDelta);

  const cases: Array<[string, ParsedDelta]> = [
    ["valid", evidenceDelta()],
    ["a model the label gate rewrites", evidenceDelta({ model: "sk-ant-secret-value" })],
    ["an offset timestamp is canonicalized", evidenceDelta({ timestamp: "2026-03-07T18:05:00+08:00" })],
    ["a microsecond interval is canonicalized", evidenceDelta({ source: "hermes" }, {
      callType: "compression", origin: "hermes-aux-ledger", timePrecision: "interval",
      intervalStart: "2026-03-07T10:00:00.123456Z", intervalEnd: "2026-03-07T10:05:00.654321Z", callCount: 3,
    })],
    ["negative tokens", evidenceDelta({ tokens: { inputTokens: -1, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 40 } })],
    ["fractional tokens", evidenceDelta({ tokens: { inputTokens: 1.5, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 40 } })],
    ["a component over the token cap", evidenceDelta({ tokens: { inputTokens: 2_000_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } })],
    ["a summed total over the token cap", evidenceDelta({ tokens: { inputTokens: 400_000_000, cachedInputTokens: 400_000_000, outputTokens: 400_000_000, reasoningOutputTokens: 400_000_000 } })],
    ["a call count over the message cap", evidenceDelta({ source: "hermes" }, {
      callType: "compression", origin: "hermes-aux-ledger", timePrecision: "interval",
      intervalStart: "2026-03-07T10:00:00.000Z", intervalEnd: "2026-03-07T10:05:00.000Z", callCount: 100_000_001,
    })],
    ["snapshot sequence zero", evidenceDelta({}, { snapshotSeq: 0 })],
    ["a non-hex event id", evidenceDelta({}, { eventId: "not-a-hash" })],
    ["an unknown origin", evidenceDelta({}, { origin: "somewhere" })],
    ["a hermes compaction", evidenceDelta({ source: "hermes" }, { callType: "compaction", origin: "hermes-review-log" })],
    ["an unprojected extra field", { ...evidenceDelta(), extra: true } as unknown as ParsedDelta],
  ];

  it.each(cases)("%s", (_label, delta) => {
    let produced: unknown = null;
    let threw = false;
    try { produced = toEvidenceRecord(delta, DEVICE); } catch { threw = true; }
    if (threw) return; // the projection refuses it; nothing reaches the ledger
    if (evidenceRecordRejection(produced) !== null) return; // the upload filter drops it
    expect(validateEvidenceRecord(produced, 0).valid).toBe(true);
  });

  // Over-cap values are projected (the ledger keeps what the raw log said) but
  // must be caught by the upload filter, not by a 400.
  it.each([
    ["a component over the token cap", evidenceDelta({ tokens: { inputTokens: 2_000_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } })],
    ["a summed total over the token cap", evidenceDelta({ tokens: { inputTokens: 400_000_000, cachedInputTokens: 400_000_000, outputTokens: 400_000_000, reasoningOutputTokens: 400_000_000 } })],
    ["a call count over the message cap", evidenceDelta({ source: "hermes" }, {
      callType: "compression", origin: "hermes-aux-ledger", timePrecision: "interval",
      intervalStart: "2026-03-07T10:00:00.000Z", intervalEnd: "2026-03-07T10:05:00.000Z", callCount: 100_000_001,
    })],
  ])("filters %s at upload instead of failing the batch", (_label, delta) => {
    const produced = toEvidenceRecord(delta, DEVICE);
    expect(evidenceRecordRejection(produced)).not.toBeNull();
    expect(validateEvidenceRecord(produced, 0).valid).toBe(false);
  });

  // The filter must not become over-strict either: a legitimate record passes.
  it.each([
    ["valid", evidenceDelta()],
    ["a secret-shaped model is relabelled", evidenceDelta({ model: "sk-ant-secret-value" })],
    ["an offset timestamp is canonicalized", evidenceDelta({ timestamp: "2026-03-07T18:05:00+08:00" })],
    ["a microsecond interval is canonicalized", evidenceDelta({ source: "hermes" }, {
      callType: "compression", origin: "hermes-aux-ledger", timePrecision: "interval",
      intervalStart: "2026-03-07T10:00:00.123456Z", intervalEnd: "2026-03-07T10:05:00.654321Z", callCount: 3,
    })],
  ])("keeps %s", (_label, delta) => {
    expect(evidenceRecordRejection(toEvidenceRecord(delta, DEVICE))).toBeNull();
  });

  // Structural rejections: the resolver drops the ledger row, so the reason
  // matters to whoever reads the warning. Records are built by the projection
  // (which normalizes) and then mutated, because some of these shapes cannot
  // be constructed by it at all.
  const projected = () => toEvidenceRecord(evidenceDelta(), DEVICE);
  const hermesProjected = () => toEvidenceRecord(evidenceDelta({ source: "hermes" }, {
    callType: "compression", origin: "hermes-aux-ledger", timePrecision: "interval",
    intervalStart: "2026-03-07T10:00:00.000Z", intervalEnd: "2026-03-07T10:05:00.000Z", callCount: 3,
  }), DEVICE);
  const withEvidence = (patch: Record<string, unknown>) => {
    const r = projected();
    return { ...r, evidence: { ...r.evidence, ...patch } };
  };

  it.each<[string, unknown, string]>([
    ["a non-object", "not a record", "record is not an object"],
    ["an unexpected top-level field", { ...projected(), extra: 1 }, "unexpected usage evidence fields"],
    ["a retired source", { ...projected(), source: "gemini-cli" }, "invalid source"],
    ["an unlabelled model", { ...projected(), model: "https://host/model" }, "model must be a usage label"],
    ["a malformed device id", { ...projected(), device_id: "has space" }, "invalid device_id"],
    ["negative tokens", { ...projected(), input_tokens: -1, total_tokens: 99 }, "input_tokens must be a non-negative integer"],
    ["a non-canonical timestamp", { ...projected(), timestamp: "2026-03-07T18:05:00+08:00" }, "timestamp and hour_start must be canonical"],
    ["an hour_start that is not the half-hour floor", { ...projected(), hour_start: "2026-03-07T10:30:00.000Z" }, "timestamp and hour_start must be canonical"],
    ["a missing evidence object", { ...projected(), evidence: null }, "evidence is required"],
    ["an unexpected evidence field", withEvidence({ extra: 1 }), "unexpected usage evidence fields"],
    ["a non-hex event id", withEvidence({ eventId: "zz" }), "invalid event identity"],
    ["a zero snapshot sequence", withEvidence({ snapshotSeq: 0 }), "invalid snapshot sequence"],
    ["an unknown call type", withEvidence({ callType: "telepathy" }), "invalid usage evidence kind"],
    ["a pi source with a hermes call kind", { ...hermesProjected(), source: "pi" }, "source does not match its call kind"],
    ["a hermes compaction", { ...hermesProjected(), evidence: { ...hermesProjected().evidence, callType: "compaction" } }, "source does not match its call kind"],
    ["a non-canonical interval bound", { ...hermesProjected(), evidence: { ...hermesProjected().evidence, intervalEnd: "2026-03-07T18:05:00+08:00" } }, "interval bounds must be canonical"],
    ["an inverted interval", { ...hermesProjected(), evidence: { ...hermesProjected().evidence, intervalStart: "2026-03-07T10:05:00.000Z", intervalEnd: "2026-03-07T10:00:00.000Z" } }, "interval_start must not be after interval_end"],
  ])("filters %s", (_label, record, expected) => {
    expect(evidenceRecordRejection(record)).toContain(expected);
  });
});

describe("isValidIsoInstant", () => {
  it("accepts the spellings the server canonicalizes", () => {
    expect(isValidIsoInstant("2026-03-07T10:30:00Z")).toBe(true);
    expect(isValidIsoInstant("2026-03-07T10:30:00.000Z")).toBe(true);
    expect(isValidIsoInstant("2026-03-07T18:30:00+08:00")).toBe(true);
    expect(isValidIsoInstant("2026-02-29T10:30:00Z")).toBe(false); // not a leap year
    expect(isValidIsoInstant("2024-02-29T10:30:00Z")).toBe(true);
  });
});
