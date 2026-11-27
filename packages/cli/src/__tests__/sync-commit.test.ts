import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountingRecord, EvidenceRecord, QueueRecord } from "@pew/core";
import { AccountingQueue, accountingKey } from "../storage/accounting-queue.js";
import { EvidenceQueue } from "../storage/evidence-queue.js";
import { evidenceKey } from "../utils/usage-evidence.js";
import { CursorStore } from "../storage/cursor-store.js";
import { LocalQueue } from "../storage/local-queue.js";
import { inclusiveAccounting } from "../utils/accounting.js";
import { recoverSyncCommit } from "../storage/sync-commit.js";

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "pew-sync-commit-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

/** A queue row as `aggregateRecords` writes it: counters already summed. */
const queueRow = (model = "glm-5", hour = "2026-03-07T10:00:00.000Z"): QueueRecord => ({
  source: "claude-code", model, hour_start: hour, device_id: "device-1",
  input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100,
  reasoning_output_tokens: 0, total_tokens: 1100,
});

const evidenceRow = (): EvidenceRecord => ({
  ...queueRow("test-model", "2026-09-06T16:00:00.000Z"),
  source: "hermes",
  timestamp: "2026-09-06T16:00:01.000Z",
  evidence: { eventId: "a".repeat(64), groupId: "b".repeat(64), callType: "approval",
    origin: "hermes-aux-ledger", provider: "openai", granularity: "session",
    timePrecision: "session-start", intervalStart: null, intervalEnd: null, callCount: 1, snapshotSeq: 1 },
});

const accountingRow = (): AccountingRecord => {
  const tokens = { inputTokens: 100, cachedInputTokens: 800, outputTokens: 30, reasoningOutputTokens: 10 };
  const g = inclusiveAccounting(tokens, { input: 900, read: 800, write: 90, output: 40, reasoning: 10 },
    { origin: "codex:last_token_usage", model: "test" });
  return { details_version: 1, source: "codex", model: "test", device_id: "test",
    hour_start: "2026-09-01T00:00:00.000Z", event_id: null, evidence_snapshot_seq: null,
    source_revision: 1, parser_revision: 1, detail_revision: 1, basis: g.basis, groups: [g] };
};

const validCursors = { version: 1 as const, files: {}, updatedAt: "2026-10-09T00:00:00.000Z" };

const validCommit = () => ({
  version: 1 as const, records: [queueRow()], dirtyKeys: ["claude-code|glm-5|2026-03-07T10:00:00.000Z|device-1"],
  evidence: [evidenceRow()], accounting: [accountingRow()], replay: false, cursors: validCursors,
});

/** Write a journal and return its path plus the state dir. */
async function journal(dir: string, body: unknown): Promise<string> {
  const path = join(dir, "sync-commit.json");
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("recoverSyncCommit quarantines a structurally damaged journal before writing anything", () => {
  /** Recover and return the quarantine file name (or null on a clean replay). */
  async function recover(dir: string) {
    const warnings: string[] = [];
    await recoverSyncCommit(dir, (m) => warnings.push(m));
    const quarantined = (await readdir(dir)).filter((n) => n.startsWith("sync-commit.corrupt-"));
    expect(quarantined.length).toBeLessThanOrEqual(1);
    return { warnings, quarantined };
  }
  it("recovers a well-formed journal", async () => {
    const dir = await temp();
    await journal(dir, validCommit());
    await recoverSyncCommit(dir);
    expect(await new LocalQueue(dir).readFromOffset(0)).toMatchObject({ records: [queueRow()] });
    expect((await new EvidenceQueue(dir).readFromOffset(0)).records.map(evidenceKey))
      .toEqual([evidenceKey(evidenceRow())]);
    expect((await new AccountingQueue(dir).readFromOffset(0)).records.map(accountingKey))
      .toEqual([accountingKey(accountingRow())]);
    expect(await new CursorStore(dir).load()).toEqual(validCursors);
    await expect(readFile(join(dir, "sync-commit.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the queue, its state and the journal intact when records is not an array", async () => {
    // Measured before the guard: `{ records: { a: 1 } }` reached overwrite(),
    // whose serialize() sees no .length and writes "" — the pending queue was
    // replaced with an empty file, and journal recovery deleted the evidence.
    const dir = await temp();
    const queue = new LocalQueue(dir);
    await queue.overwrite([queueRow("gpt-5", "2026-03-07T11:00:00.000Z")]);
    await queue.saveDirtyKeys(["claude-code|gpt-5|2026-03-07T11:00:00.000Z|device-1"]);
    const before = await readFile(join(dir, "queue.jsonl"), "utf8");
    const stateBefore = await readFile(join(dir, "queue.state.json"), "utf8");
    await journal(dir, { ...validCommit(), records: { a: 1 } });

    const { quarantined, warnings } = await recover(dir);
    expect(quarantined).toHaveLength(1);
    expect(warnings.join(" ")).toContain(quarantined[0]);
    expect(await readFile(join(dir, "queue.jsonl"), "utf8")).toBe(before);
    expect(await readFile(join(dir, "queue.state.json"), "utf8")).toBe(stateBefore);
    expect(JSON.parse(await readFile(join(dir, quarantined[0]!), "utf8"))).toMatchObject({ records: { a: 1 } });
  });

  it("leaves the queue intact when records holds non-record entries", async () => {
    // `records: [1, 2]` is an array, so it overwrote queue.jsonl with "1\n2\n".
    const dir = await temp();
    const queue = new LocalQueue(dir);
    await queue.overwrite([queueRow()]);
    const before = await readFile(join(dir, "queue.jsonl"), "utf8");
    await journal(dir, { ...validCommit(), records: [1, 2] });

    expect((await recover(dir)).quarantined).toHaveLength(1);
    expect(await readFile(join(dir, "queue.jsonl"), "utf8")).toBe(before);
  });

  it.each([
    ["a missing cursor", {}],
    ["a non-object cursor", "garbage"],
    ["a cursor without a files map", { version: 1 }],
    ["a cursor whose files is not a map", { version: 1, files: [] }],
  ])("leaves cursors.json intact when the journal carries %s", async (_label, cursors) => {
    // `cursors: "garbage"` was saved verbatim and the journal deleted, so the
    // next sync read a nonsense cursor file instead of a recoverable journal.
    const dir = await temp();
    const store = new CursorStore(dir);
    const before = { version: 1 as const, files: { "/kept": { inode: 1, offset: 10, updatedAt: "x" } }, updatedAt: "x" };
    await store.save(before);
    await journal(dir, { ...validCommit(), cursors });

    expect((await recover(dir)).quarantined).toHaveLength(1);
    expect(await store.load()).toEqual(before);
  });

  it("validates every payload before the first write", async () => {
    // Ordering is the point: a valid evidence batch plus a damaged accounting
    // batch used to merge evidence first and throw afterwards, so the ledger
    // grew while the journal stayed — the same batch would then merge again.
    const dir = await temp();
    await journal(dir, {
      ...validCommit(),
      evidence: [evidenceRow()],
      accounting: [{ source_revision: 1 }],
    });

    expect((await recover(dir)).quarantined).toHaveLength(1);
    await expect(readFile(join(dir, "evidence-queue.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "accounting-queue.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "queue.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "cursors.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["records is not an array", { records: "rows" }],
    ["dirtyKeys is not a list of strings", { dirtyKeys: [1] }],
    ["dirtyKeys is not an array", { dirtyKeys: "claude-code|x" }],
    ["evidence is not an array", { evidence: {} }],
    ["replay is not a boolean", { replay: "yes" }],
    ["preserveAccountingSources is not a list", { preserveAccountingSources: "antigravity" }],
  ])("quarantines a journal whose %s", async (_label, patch) => {
    const dir = await temp();
    await journal(dir, { ...validCommit(), ...patch });
    expect((await recover(dir)).quarantined).toHaveLength(1);
  });

  it("keeps a queue row this build does not understand", async () => {
    // The queue legitimately holds rows the current build cannot interpret —
    // an incremental sync passes stale rows through `aggregateRecords`
    // unchanged, and a newer CLI may know sources this one does not. Rejecting
    // those turned every such sync into an unrecoverable journal; only values
    // the JSONL format cannot hold (non-objects) are damage.
    const dir = await temp();
    await journal(dir, { ...validCommit(), records: [{ stale: true }] });
    await recoverSyncCommit(dir);
    expect((await new LocalQueue(dir).readFromOffset(0)).records).toMatchObject([{ stale: true }]);
  });

  it("still treats a missing journal as a no-op", async () => {
    const dir = await temp();
    await expect(recoverSyncCommit(dir)).resolves.toBeUndefined();
  });

  it("quarantines a damaged journal instead of wedging every later command", async () => {
    // Throwing INVALID made every sync/upload/reset fail before doing any
    // work, forever: the only fix was an operator hand-deleting the file.
    // Nothing durable is applied from an unreadable journal anyway, and the
    // sync that would follow re-reads the raw logs from the cursors — the
    // same rebuild the "no journal" path relies on. So: keep the damaged
    // file for inspection under a corrupt-* name, warn with its path, and
    // let the command proceed.
    const dir = await temp();
    const path = await journal(dir, { ...validCommit(), records: { a: 1 } });
    const warnings: string[] = [];

    await expect(recoverSyncCommit(dir, (m) => warnings.push(m))).resolves.toBeUndefined();

    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    const entries = await readdir(dir);
    const quarantined = entries.filter((name) => name.startsWith("sync-commit.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, quarantined[0]!), "utf8"))).toMatchObject({ records: { a: 1 } });
    expect(warnings.join(" ")).toContain(quarantined[0]);
    // Nothing from the journal was applied.
    await expect(readFile(join(dir, "queue.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps accepting retired sources in records, evidence and accounting", async () => {
    // Retired sources remain readable and uploadable; the guard must not turn
    // a retained backlog into an unrecoverable journal.
    const dir = await temp();
    await journal(dir, {
      ...validCommit(),
      records: [{ ...queueRow(), source: "gemini-cli" }],
      preserveAccountingSources: ["antigravity"],
    });
    await recoverSyncCommit(dir);
    expect((await new LocalQueue(dir).readFromOffset(0)).records).toMatchObject([{ source: "gemini-cli" }]);
  });
});
