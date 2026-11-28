import { describe, it, expect } from "vitest";
import { planAccountingUpdates } from "../storage/accounting-queue.js";
import { validateAccountingRecord } from "@pew/core";
import { inclusiveAccounting } from "../utils/accounting.js";
import type { ParsedDelta } from "../parsers/claude.js";

// The accounting detail's model must be the model the token bucket was
// uploaded under, byte for byte: the server's base lookup matches
// `usage_records.model` exactly. Normalizing the detail model to the ASCII
// label rule ("unknown") while the token bucket keeps the raw model made every
// such detail answer `base_mismatch` forever, reset the ledger key so
// revisions restarted from 1, and could attach a detail to a literal
// "unknown" bucket of another model. The server boundary accepts the same
// model domain as the token endpoint (non-empty, ≤1024), so the plan keeps the
// model verbatim.

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

function evidenceDelta(model: string, snapshotSeq: number): ParsedDelta {
  return {
    ...delta(model),
    evidence: { eventId: "a".repeat(64), groupId: null, callType: null, origin: null,
      provider: "anthropic", granularity: "request", snapshotSeq },
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

describe("planAccountingUpdates keeps models the accounting endpoint must base-match", () => {
  it("keeps a unicode model verbatim so the detail can match its token bucket", () => {
    const updates = plan("模型-hunyuan-x1");
    expect(updates).toHaveLength(1);
    expect(updates[0].model).toBe("模型-hunyuan-x1");
    expect(updates[0].groups.every((g) => g.model === "模型-hunyuan-x1")).toBe(true);
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });

  it("keeps a model at the token endpoint's 1024-char bound verbatim", () => {
    const updates = plan("m".repeat(1024));
    expect(updates).toHaveLength(1);
    expect(updates[0].model).toBe("m".repeat(1024));
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });

  it("keeps a secret-shaped model verbatim, matching the token endpoint's domain", () => {
    const updates = plan("sk-abc123");
    expect(updates).toHaveLength(1);
    expect(updates[0].model).toBe("sk-abc123");
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });

  it("keeps a plain ASCII model verbatim", () => {
    const updates = plan("hunyuan-x1");
    expect(updates).toHaveLength(1);
    expect(updates[0].model).toBe("hunyuan-x1");
    expect(validateAccountingRecord(updates[0], 0).valid).toBe(true);
  });

  it("finds the previous ledger record on the second evidence snapshot and advances revisions", () => {
    // With the detail model normalized but the ledger key raw, `previous.get`
    // missed on every sync: snapshotSeq 2 was treated as the first snapshot,
    // source_revision reset to 1, the server answered `conflict` for the
    // revision it already held, and the detail froze at its first frame.
    for (const model of ["模型-hunyuan-x1", "hunyuan-x1"]) {
      const first = planAccountingUpdates({
        previous: [], before: [], after: afterFor(model), replay: false, deviceId: "test",
        deltas: [evidenceDelta(model, 1)],
      });
      expect(first).toHaveLength(1);
      const second = planAccountingUpdates({
        previous: first, before: [], after: afterFor(model), replay: false, deviceId: "test",
        deltas: [evidenceDelta(model, 2)],
      });
      expect(second).toHaveLength(1);
      expect(second[0].model).toBe(model);
      expect(second[0].source_revision).toBe(2);
    }
  });
});
