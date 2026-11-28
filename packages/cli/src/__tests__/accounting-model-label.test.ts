import { describe, it, expect } from "vitest";
import { planAccountingUpdates } from "../storage/accounting-queue.js";
import { validateAccountingRecord } from "@pew/core";
import { inclusiveAccounting } from "../utils/accounting.js";
import type { ParsedDelta } from "../parsers/claude.js";

// The accounting ingest endpoint validates `model` with the strict label rule
// (ASCII, ≤128 chars) while the token endpoint accepts any non-empty string
// up to 1024. A delta whose model passes the token upload but fails the
// accounting one would make the details upload 400 forever — the engine does
// not retry a 4xx and the dirty keys never clear — so the queue plan must
// normalize every model through usageLabel, exactly like the evidence path
// already does. (Ported from the combined line's c84b0342: this line lacked
// the fix, and without it the record failed checkedRecord and was dropped
// with only a per-source warning.)

const tokens = { inputTokens: 100, cachedInputTokens: 800, outputTokens: 30, reasoningOutputTokens: 10 };

function delta(model: string): ParsedDelta {
  return {
    source: "claude-code",
    model,
    timestamp: "2026-09-01T00:00:01.000Z",
    tokens,
    accounting: inclusiveAccounting(tokens, { input: 900, read: 800, write: 0, output: 40, reasoning: 10 }, { origin: "claude-code:usage", model }),
  } as ParsedDelta;
}

// The plan only emits an update when the delta's basis matches the token
// bucket the token upload produced, so `after` must carry the same bucket.
// The token bucket keeps the RAW model as its key.
function afterFor(model: string) {
  return [{ source: "claude-code", model, device_id: "test", hour_start: "2026-09-01T00:00:00.000Z",
    input_tokens: 100, cached_input_tokens: 800, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 940 }];
}

function plan(model: string) {
  return planAccountingUpdates({
    previous: [], before: [], after: afterFor(model), replay: false, deviceId: "test", deltas: [delta(model)],
  });
}

describe("planAccountingUpdates normalizes models that the accounting endpoint would reject", () => {
  it("maps a unicode model to 'unknown' so validateAccountingRecord passes", () => {
    const updates = plan("模型-hunyuan-x1");
    expect(updates).toHaveLength(1);
    expect(updates[0].model).toBe("unknown");
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });

  it("maps an over-128-char model to 'unknown' so validateAccountingRecord passes", () => {
    const updates = plan("m".repeat(1024));
    expect(updates).toHaveLength(1);
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });

  it("maps a secret-shaped model to 'unknown' so validateAccountingRecord passes", () => {
    const updates = plan("sk-abc123");
    expect(updates).toHaveLength(1);
    expect(updates[0].model).toBe("unknown");
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });

  it("keeps a plain ASCII model verbatim", () => {
    const updates = plan("hunyuan-x1");
    expect(updates).toHaveLength(1);
    expect(updates[0].model).toBe("hunyuan-x1");
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });
});
