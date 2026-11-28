import { describe, expect, it } from "vitest";
import { describeSkippedHint, describeSyncOutcome } from "@/lib/sync-outcome";

describe("describeSyncOutcome", () => {
  it("calls a 200 with no skip a success", () => {
    expect(describeSyncOutcome(200, { ok: true })).toEqual({ kind: "ok" });
  });

  it("calls a 200 that published nothing a skip, not a success", () => {
    // The run lost to a newer publication and wrote nothing. The route still
    // answers 200 because nothing failed, so status alone cannot tell these
    // apart — the outcome field must.
    expect(describeSyncOutcome(200, { ok: true, skippedReason: "a newer sync (2026-09-01T00:00:00.000Z)" }))
      .toEqual({ kind: "skipped", reason: "a newer sync (2026-09-01T00:00:00.000Z)" });
  });

  it("keeps a 207 partial failure a partial failure even when the run also skipped", () => {
    // A skipped run reports its fetch errors alongside the skip. The operator
    // still needs to know the sources failed, not just that nothing landed.
    expect(describeSyncOutcome(207, { ok: false, skippedReason: "a newer sync" }).kind).toBe("skipped");
    expect(describeSyncOutcome(207, { ok: false }).kind).toBe("partial");
  });

  it("describes a skipped run by what actually happened, not a fixed sentence", () => {
    // The skip reason is now more than "a newer run won": a KV read failure
    // also refuses to publish. The button rendered one hardcoded sentence for
    // every skip and told the operator the catalogue was fresh.
    expect(describeSkippedHint("a newer sync (2026-09-01T00:00:00.000Z) is already published; this run's result was discarded"))
      .toBe("No change: a newer price update is already published");
    expect(describeSkippedHint("the stored pricing metadata could not be read (KV error); the published catalogue was left untouched"))
      .toBe("No prices published: the stored pricing data could not be read. Try again later.");
    expect(describeSkippedHint("something else")).toBe("No prices published: something else");
    expect(describeSkippedHint("")).toBe("No prices were published by this run");
  });

  it("treats every non-2xx as an error, including a 502 body that looks clean", () => {
    expect(describeSyncOutcome(502, { ok: true })).toEqual({ kind: "error" });
    expect(describeSyncOutcome(403, null)).toEqual({ kind: "error" });
  });

  it("ignores a non-string or empty skippedReason", () => {
    expect(describeSyncOutcome(200, { ok: true, skippedReason: "" }).kind).toBe("ok");
    expect(describeSyncOutcome(200, { ok: true, skippedReason: 7 }).kind).toBe("ok");
    expect(describeSyncOutcome(200, null).kind).toBe("ok");
  });
});
