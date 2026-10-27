import { describe, expect, it } from "vitest";
import {
  isValidIsoInstant,
  sessionRecordRejection,
  tokenRecordRejection,
} from "../utils/ingest-contract.js";
import {
  validateIngestRecord,
  validateSessionIngestRecord,
} from "@pew/core";

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

describe("isValidIsoInstant", () => {
  it("accepts the spellings the server canonicalizes", () => {
    expect(isValidIsoInstant("2026-03-07T10:30:00Z")).toBe(true);
    expect(isValidIsoInstant("2026-03-07T10:30:00.000Z")).toBe(true);
    expect(isValidIsoInstant("2026-03-07T18:30:00+08:00")).toBe(true);
    expect(isValidIsoInstant("2026-02-29T10:30:00Z")).toBe(false); // not a leap year
    expect(isValidIsoInstant("2024-02-29T10:30:00Z")).toBe(true);
  });
});
