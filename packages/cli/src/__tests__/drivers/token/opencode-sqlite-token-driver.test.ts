import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { createOpenCodeSqliteTokenDriver } from "../../../drivers/token/opencode-sqlite-token-driver.js";
import type { OpenCodeSqliteCursor } from "@pew/core";
import type { SyncContext } from "../../../drivers/types.js";
import type { MessageRow } from "../../../parsers/opencode-sqlite.js";

/** Helper: create a mock MessageRow */
function mockRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-001",
    session_id: "ses-001",
    time_created: 1709827200000,
    role: "assistant",
    data: JSON.stringify({
      modelID: "claude-sonnet-4-20250514",
      time: {
        created: 1709827200,
        completed: 1709827260,
      },
      tokens: {
        input: 500,
        output: 200,
        cache: { read: 0, write: 0 },
        reasoning: 0,
      },
    }),
    ...overrides,
  };
}

describe("openCodeSqliteTokenDriver", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pew-opencode-sqlite-driver-"));
    dbPath = join(tempDir, "messages.db");
    // Create a fake DB file (we mock the actual DB operations)
    await writeFile(dbPath, "fake-sqlite-content");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("has correct kind and source", () => {
    const driver = createOpenCodeSqliteTokenDriver({
      dbPath,
      openMessageDb: () => null,
    });
    expect(driver.kind).toBe("db");
    expect(driver.source).toBe("opencode");
  });

  it("returns empty result when DB file does not exist", async () => {
    const driver = createOpenCodeSqliteTokenDriver({
      dbPath: join(tempDir, "nonexistent.db"),
      openMessageDb: () => null,
    });

    const ctx: SyncContext = {};
    const result = await driver.run(undefined, ctx);

    expect(result.deltas).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.cursor.lastTimeCreated).toBe(0);
  });

  it("returns empty result when openMessageDb returns null", async () => {
    const driver = createOpenCodeSqliteTokenDriver({
      dbPath,
      openMessageDb: () => null,
    });

    const ctx: SyncContext = {};
    const result = await driver.run(undefined, ctx);

    expect(result.deltas).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("processes messages from DB and returns deltas + cursor", async () => {
    const rows: MessageRow[] = [
      mockRow({ id: "msg-001", time_created: 1709827200000 }),
      mockRow({ id: "msg-002", time_created: 1709827300000 }),
    ];

    let closeCalled = false;
    const driver = createOpenCodeSqliteTokenDriver({
      dbPath,
      openMessageDb: () => ({
        queryMessages: (_lastTime: number) => rows,
        close: () => { closeCalled = true; },
      }),
    });

    const ctx: SyncContext = {};
    const result = await driver.run(undefined, ctx);

    expect(result.deltas.length).toBeGreaterThanOrEqual(1);
    expect(result.rowCount).toBe(2);
    expect(result.cursor.lastTimeCreated).toBe(1709827300000);
    expect(result.cursor.lastProcessedIds).toEqual(["msg-002"]);
    expect(closeCalled).toBe(true);
  });

  it("deduplicates using ctx.messageKeys from JSON driver", async () => {
    const rows: MessageRow[] = [
      mockRow({ id: "msg-001", session_id: "ses-001", time_created: 1709827200000 }),
    ];

    const driver = createOpenCodeSqliteTokenDriver({
      dbPath,
      openMessageDb: () => ({
        queryMessages: (_lastTime: number) => rows,
        close: () => {},
      }),
    });

    // The JSON driver deposited this messageKey → SQLite should skip it
    const ctx: SyncContext = {
      messageKeys: new Set(["ses-001|msg-001"]),
    };
    const result = await driver.run(undefined, ctx);

    // The row is an assistant message with matching messageKey → deduped
    expect(result.deltas).toEqual([]);
    expect(result.rowCount).toBe(1); // raw rows still counted
    expect(result.cursor.lastTimeCreated).toBe(1709827200000);
  });

  it("resumes from previous cursor watermark", async () => {
    const dbStat = await stat(dbPath);
    const prevCursor: OpenCodeSqliteCursor = {
      lastTimeCreated: 1709827200000,
      lastProcessedIds: ["msg-001"],
      lastSessionUpdated: 0,
      inode: dbStat.ino,
      updatedAt: "2026-01-01T00:00:00Z",
    };

    // queryMessages returns 2 rows: msg-001 at watermark, msg-002 new
    const rows: MessageRow[] = [
      mockRow({ id: "msg-001", time_created: 1709827200000 }),
      mockRow({ id: "msg-002", time_created: 1709827400000 }),
    ];

    const driver = createOpenCodeSqliteTokenDriver({
      dbPath,
      openMessageDb: () => ({
        queryMessages: (lastTime: number) => {
          // Should be called with the watermark
          expect(lastTime).toBe(1709827200000);
          return rows;
        },
        close: () => {},
      }),
    });

    const ctx: SyncContext = {};
    const result = await driver.run(prevCursor, ctx);

    // msg-001 should be filtered by lastProcessedIds
    expect(result.rowCount).toBe(2); // raw count includes all
    // Only msg-002 should produce deltas (msg-001 deduped by lastProcessedIds)
    expect(result.cursor.lastTimeCreated).toBe(1709827400000);
  });
});

describe("openCodeSqliteTokenDriver — messages written after first observation", () => {
  let tempDir: string;
  let dbPath: string;
  // Fresh clock: OpenCode fills in tokens seconds after inserting the row, so
  // these rows must look like they were created moments ago.
  let baseTime: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pew-opencode-sqlite-pending-"));
    dbPath = join(tempDir, "messages.db");
    await writeFile(dbPath, "fake-sqlite-content");
    baseTime = Date.now() - 60_000;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** In-flight assistant row: OpenCode inserts it before the LLM call with zero tokens. */
  function inFlightRow(id: string, timeCreated: number, sessionId = "ses-001"): MessageRow {
    return {
      id,
      session_id: sessionId,
      time_created: timeCreated,
      role: "assistant",
      data: JSON.stringify({
        modelID: "claude-sonnet-4-20250514",
        time: { created: timeCreated },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    };
  }

  /** The same row once step-finish and cleanup have written tokens + completed. */
  function settledRow(id: string, timeCreated: number, sessionId = "ses-001"): MessageRow {
    return {
      id,
      session_id: sessionId,
      time_created: timeCreated,
      role: "assistant",
      data: JSON.stringify({
        modelID: "claude-sonnet-4-20250514",
        time: { created: timeCreated, completed: timeCreated + 60_000 },
        tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    };
  }

  function makeDriver(getRows: () => MessageRow[]) {
    return createOpenCodeSqliteTokenDriver({
      dbPath,
      openMessageDb: () => ({
        queryMessages: (lastTime: number, pendingIds: readonly string[] = []) =>
          getRows().filter(
            (r) => r.time_created >= lastTime || pendingIds.includes(r.id),
          ),
        close: () => {},
      }),
    });
  }

  it("re-reads a message whose tokens were written after the first observation", async () => {
    let rows = [inFlightRow("msg-001", baseTime)];
    const driver = makeDriver(() => rows);

    // First sync lands mid-generation: zero tokens, nothing to emit.
    const first = await driver.run(undefined, {});
    expect(first.deltas).toEqual([]);
    expect(first.cursor.pendingIds).toEqual(["msg-001"]);

    // step-finish + cleanup write the real tokens; time_created is unchanged.
    rows = [settledRow("msg-001", baseTime)];
    const second = await driver.run(first.cursor, {});
    expect(second.deltas).toHaveLength(1);
    expect(second.deltas[0].tokens.inputTokens).toBe(500);
    expect(second.cursor.pendingIds ?? []).toEqual([]);

    // Third sync must not emit it again.
    const third = await driver.run(second.cursor, {});
    expect(third.deltas).toEqual([]);
  });

  it("keeps a still-unsettled message pending across syncs", async () => {
    const rows = [inFlightRow("msg-001", baseTime)];
    const driver = makeDriver(() => rows);

    const first = await driver.run(undefined, {});
    const second = await driver.run(first.cursor, {});
    expect(second.deltas).toEqual([]);
    expect(second.cursor.pendingIds).toEqual(["msg-001"]);
  });

  it("recovers a pending message even after the watermark has advanced past it", async () => {
    // Sync 1 sees an in-flight message plus a settled one created later; the
    // watermark advances to the settled row's timestamp.
    let rows = [
      inFlightRow("msg-early", baseTime),
      settledRow("msg-late", baseTime + 20_000),
    ];
    const driver = makeDriver(() => rows);

    const first = await driver.run(undefined, {});
    expect(first.deltas).toHaveLength(1); // only msg-late
    expect(first.cursor.lastTimeCreated).toBe(baseTime + 20_000);
    expect(first.cursor.pendingIds).toEqual(["msg-early"]);

    // msg-early finishes; its time_created is now below the watermark.
    rows = [
      settledRow("msg-early", baseTime),
      settledRow("msg-late", baseTime + 20_000),
    ];
    const second = await driver.run(first.cursor, {});
    expect(second.deltas).toHaveLength(1);
    expect(second.deltas[0].model).toBe("claude-sonnet-4-20250514");
    expect(second.cursor.pendingIds ?? []).toEqual([]);

    const third = await driver.run(second.cursor, {});
    expect(third.deltas).toEqual([]);
  });

  it("drops a pending id whose row no longer exists", async () => {
    let rows = [inFlightRow("msg-001", baseTime)];
    const driver = makeDriver(() => rows);

    const first = await driver.run(undefined, {});
    expect(first.cursor.pendingIds).toEqual(["msg-001"]);

    rows = []; // session deleted / reverted
    const second = await driver.run(first.cursor, {});
    expect(second.deltas).toEqual([]);
    expect(second.cursor.pendingIds ?? []).toEqual([]);
  });

  it("never moves the watermark backwards when only pending rows are re-read", async () => {
    let rows = [
      inFlightRow("msg-early", baseTime),
      settledRow("msg-late", baseTime + 20_000),
    ];
    const driver = makeDriver(() => rows);

    const first = await driver.run(undefined, {});
    expect(first.cursor.lastTimeCreated).toBe(baseTime + 20_000);

    // The late row disappears (session deleted) and only the older pending row
    // remains; re-reading it must not pull the watermark back down.
    rows = [inFlightRow("msg-early", baseTime)];
    const second = await driver.run(first.cursor, {});
    expect(second.cursor.lastTimeCreated).toBe(baseTime + 20_000);
    expect(second.cursor.pendingIds).toEqual(["msg-early"]);
    expect(second.deltas).toEqual([]);
  });

  it("keeps the boundary dedup when a run leaves the watermark unchanged", async () => {
    // msg-late sits at the watermark; msg-early stays in flight.
    const rows = [
      inFlightRow("msg-early", baseTime),
      settledRow("msg-late", baseTime + 20_000),
    ];
    const driver = makeDriver(() => rows);

    const first = await driver.run(undefined, {});
    expect(first.deltas).toHaveLength(1);
    expect(first.cursor.lastProcessedIds).toEqual(["msg-late"]);

    // Next run re-reads only the pending row; the watermark does not move, so
    // msg-late is still in the `>=` window and must stay deduped.
    const second = await driver.run(first.cursor, {});
    expect(second.deltas).toEqual([]);
    expect(second.cursor.lastTimeCreated).toBe(baseTime + 20_000);
    expect(second.cursor.lastProcessedIds).toContain("msg-late");

    const third = await driver.run(second.cursor, {});
    expect(third.deltas).toEqual([]);
  });
});
