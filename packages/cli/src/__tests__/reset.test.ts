import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeReset } from "../commands/reset.js";

describe("executeReset", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pew-reset-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should delete all 6 state files when they exist", async () => {
    const files = [
      "cursors.json",
      "queue.jsonl",
      "queue.state.json",
      "session-cursors.json",
      "session-queue.jsonl",
      "session-queue.state.json",
    ];
    for (const f of files) {
      await writeFile(join(tempDir, f), f.endsWith("jsonl") ? "" : "{}");
    }

    const result = await executeReset({ stateDir: tempDir });

    expect(result.files).toHaveLength(6);
    for (const f of result.files) {
      expect(f.deleted).toBe(true);
    }

    const remaining = await readdir(tempDir);
    expect(remaining).toHaveLength(0);
  });

  it("should skip missing files without error", async () => {
    // Only create 2 of 6 files
    await writeFile(join(tempDir, "cursors.json"), "{}");
    await writeFile(join(tempDir, "queue.jsonl"), "");

    const result = await executeReset({ stateDir: tempDir });

    expect(result.files).toHaveLength(6);

    const deleted = result.files.filter((f) => f.deleted);
    const skipped = result.files.filter((f) => !f.deleted);
    expect(deleted).toHaveLength(2);
    expect(skipped).toHaveLength(4);

    expect(deleted.map((f) => f.file).sort()).toEqual([
      "cursors.json",
      "queue.jsonl",
    ]);
  });

  it("should handle completely empty state dir", async () => {
    const result = await executeReset({ stateDir: tempDir });

    expect(result.files).toHaveLength(6);
    for (const f of result.files) {
      expect(f.deleted).toBe(false);
    }
  });

  it("should not touch unrelated files in state dir", async () => {
    await writeFile(join(tempDir, "config.json"), '{"token":"pk_123"}');
    await writeFile(join(tempDir, "config.dev.json"), '{"token":"pk_dev"}');
    await writeFile(join(tempDir, "cursors.json"), "{}");

    const result = await executeReset({ stateDir: tempDir });

    const deleted = result.files.filter((f) => f.deleted);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].file).toBe("cursors.json");

    // Config files must survive
    const remaining = await readdir(tempDir);
    expect(remaining.sort()).toEqual(["config.dev.json", "config.json"]);
  });

  it("keeps only the recorded upload target when a full reset deletes the queue state", async () => {
    // A full reset deletes the queue, and the next sync replays everything
    // through it — exactly the run where a wrong host sends all history at
    // once. The target must survive even though offset/dirtyKeys do not.
    await writeFile(join(tempDir, "queue.jsonl"), "\n");
    await writeFile(join(tempDir, "queue.state.json"),
      `${JSON.stringify({ offset: 0, dirtyKeys: [], lastUploadTarget: "http://pew.corp:7020" })}\n`);
    await writeFile(join(tempDir, "session-queue.state.json"),
      `${JSON.stringify({ offset: 0, lastUploadTarget: "http://pew.corp:7020" })}\n`);

    const result = await executeReset({ stateDir: tempDir });

    // Reported as recreated, not deleted: the CLI must not print a plain "✓"
    // for a file that is still on disk.
    expect(result.files.find((f) => f.file === "queue.state.json")).toMatchObject({
      deleted: true,
      recreated: true,
    });
    expect(JSON.parse(await readFile(join(tempDir, "queue.state.json"), "utf8"))).toEqual({
      offset: 0,
      lastUploadTarget: "http://pew.corp:7020",
    });
    expect(JSON.parse(await readFile(join(tempDir, "session-queue.state.json"), "utf8"))).toEqual({
      offset: 0,
      lastUploadTarget: "http://pew.corp:7020",
    });
    await expect(stat(join(tempDir, "queue.jsonl"))).rejects.toThrow();
  });

  it("recreates the retained queue state atomically, leaving no temp file", async () => {
    // reset runs under the state lock, but a crash mid-write would leave a
    // half-written queue.state.json — and loadState() only recovers raw queue
    // files, not this one. Write-then-rename keeps it whole or untouched.
    // Other state files are owner-only; this rewrite must not loosen that.
    await writeFile(join(tempDir, "queue.state.json"),
      `${JSON.stringify({ offset: 0, dirtyKeys: [], lastUploadTarget: "http://pew.corp:7020" })}\n`);

    await executeReset({ stateDir: tempDir });

    expect(JSON.parse(await readFile(join(tempDir, "queue.state.json"), "utf8"))).toEqual({
      offset: 0,
      lastUploadTarget: "http://pew.corp:7020",
    });
    expect((await stat(join(tempDir, "queue.state.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(tempDir)).toEqual(["queue.state.json"]);
  });

  it("should propagate non-ENOENT errors", async () => {
    const permError = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const unlinkFn = vi.fn().mockRejectedValue(permError);

    await expect(
      executeReset({ stateDir: tempDir, unlinkFn: unlinkFn as any }),
    ).rejects.toThrow("EACCES");
  });

  it("should return correct file names in order", async () => {
    const result = await executeReset({ stateDir: tempDir });

    expect(result.files.map((f) => f.file)).toEqual([
      "cursors.json",
      "queue.jsonl",
      "queue.state.json",
      "session-cursors.json",
      "session-queue.jsonl",
      "session-queue.state.json",
    ]);
  });

  it("should accept custom unlinkFn for DI", async () => {
    const calls: string[] = [];
    const unlinkFn = vi.fn(async (path: string) => {
      calls.push(path);
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    });

    await executeReset({ stateDir: tempDir, unlinkFn: unlinkFn as any });

    expect(calls).toHaveLength(6);
    expect(calls[0]).toBe(join(tempDir, "cursors.json"));
    expect(calls[5]).toBe(join(tempDir, "session-queue.state.json"));
  });

  it("surfaces the recovery merge's conflict warning instead of reporting a clean reset", async () => {
    // reset is what an operator runs when sync is wedged, so a conflict the
    // recovery merge resolved by keeping the stored copy has to reach them —
    // otherwise the ledger still holds a forked snapshot while the command
    // prints a plain success.
    const evidence = {
      source: "hermes" as const, model: "test-model", device_id: "test-device",
      timestamp: "2026-09-06T16:00:01.000Z", hour_start: "2026-09-06T16:00:00.000Z",
      input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120,
      evidence: { eventId: "a".repeat(64), groupId: "b".repeat(64), callType: "approval" as const,
        origin: "hermes-aux-ledger" as const, provider: "openai", granularity: "session" as const,
        timePrecision: "session-start" as const, intervalStart: null, intervalEnd: null, callCount: 1, snapshotSeq: 1 },
    };
    const { EvidenceQueue } = await import("../storage/evidence-queue.js");
    await new EvidenceQueue(tempDir).merge([evidence]);
    await writeFile(join(tempDir, "sync-commit.json"), JSON.stringify({
      version: 1, evidence: [{ ...evidence, input_tokens: 200, total_tokens: 220 }],
      accounting: [], replay: false,
      cursors: { version: 1, files: {}, updatedAt: "2026-10-09T00:00:00.000Z" },
    }));

    const result = await executeReset({ stateDir: tempDir });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toMatch(/Kept the stored copy/);
    // The conflicting copy never replaced the stored one.
    expect((await new EvidenceQueue(tempDir).readFromOffset(0)).records[0]).toMatchObject({ input_tokens: 100 });
  });
});
