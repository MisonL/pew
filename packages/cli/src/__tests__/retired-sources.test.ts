import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueRecord, Source } from "@pew/core";
import { executeNotify } from "../commands/notify.js";
import { executeReset } from "../commands/reset.js";
import { executeSync } from "../commands/sync.js";
import { LocalQueue } from "../storage/local-queue.js";
import { CursorStore } from "../storage/cursor-store.js";
import { getAllDrivers } from "../notifier/registry.js";
import { SessionQueue } from "../storage/session-queue.js";
import { BaseQueue } from "../storage/base-queue.js";

const retired: Source[] = ["gemini-cli", "kosmos", "omp", "zcode", "pmstudio", "vscode-copilot"];
const row = (source: Source, device_id = "old-device"): QueueRecord => ({ source, device_id, model: "historic-model",
  hour_start: "2026-01-01T00:00:00.000Z", input_tokens: 100, cached_input_tokens: 900,
  output_tokens: 40, reasoning_output_tokens: 60, total_tokens: 1100 });
const key = (r: QueueRecord) => `${r.source}|${r.model}|${r.hour_start}|${r.device_id}`;

describe("retired sources", () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "pew-retired-")); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  it("does not install retired notifiers", () => {
    expect(getAllDrivers().map((d) => d.source)).not.toEqual(expect.arrayContaining(["gemini-cli"]));
    expect(getAllDrivers().every((d) => !retired.includes(d.source))).toBe(true);
  });

  it.each(retired)("acknowledges old %s hooks without syncing or creating state", async (source) => {
    const sync = vi.fn();
    const result = await executeNotify({ stateDir, deviceId: "device", source, coordinatedSyncFn: sync });
    expect(result.skippedSync).toBe(true);
    expect(sync).not.toHaveBeenCalled();
  });

  it("retains all retired buckets and pending keys across a full rescan", async () => {
    const queue = new LocalQueue(stateDir);
    const history = retired.map((s) => row(s));
    await queue.overwrite([...history, row("claude-code")]);
    await queue.saveDirtyKeys([key(history[0])]);
    await executeSync({ stateDir, deviceId: "device" });
    expect((await queue.readFromOffset(0)).records).toEqual(history);
    expect(await queue.loadDirtyKeys()).toEqual([key(history[0])]);
  });

  it("retains historical rows on reset and subsequent empty rescan", async () => {
    const queue = new LocalQueue(stateDir);
    const history = retired.map((s) => row(s));
    await queue.overwrite([...history, row("claude-code")]);
    await queue.saveDirtyKeys([key(history[2])]);
    await executeReset({ stateDir });
    expect((await queue.readFromOffset(0)).records).toEqual(history);
    expect(await queue.loadDirtyKeys()).toEqual([key(history[2])]);
    await executeSync({ stateDir, deviceId: "device" });
    expect((await queue.readFromOffset(0)).records).toEqual(history);
    expect(await queue.loadDirtyKeys()).toEqual([key(history[2])]);
  });

  it("discards obsolete default cursors before checking schema replay", async () => {
    await new CursorStore(stateDir).save({ version: 1, updatedAt: null, files: {
      "/home/test/.gemini/tmp/id/chats/session-1.json": { inode: 1, mtimeMs: 0, size: 0, updatedAt: "2026-01-01" } as never,
    }, knownFilePaths: { "/home/test/.gemini/tmp/id/chats/session-1.json": true } });
    const progress = vi.fn();
    await executeSync({ stateDir, deviceId: "device", onProgress: progress });
    expect(progress.mock.calls.some(([e]) => e.message?.includes("one-time full rescan"))).toBe(false);
    expect((await new CursorStore(stateDir).load()).files).toEqual({});
  });

  it("retains retired sessions and their legacy pending offset across reset", async () => {
    const queue = new SessionQueue(stateDir);
    const records = retired.map((source) => ({ session_key: `${source}:test`, source, kind: "human" as const,
      started_at: "2026-01-01T00:00:00Z", last_message_at: "2026-01-01T00:01:00Z", snapshot_at: "2026-01-01T00:02:00Z",
      duration_seconds: 60, user_messages: 1, assistant_messages: 1, total_messages: 2, project_ref: null, model: null }));
    await queue.overwrite(records);
    const offset = Buffer.byteLength(`${JSON.stringify(records[0])}\n`);
    await queue.saveOffset(offset);
    await executeReset({ stateDir });
    expect((await queue.readFromOffset(0)).records).toEqual(records);
    expect(await queue.loadDirtyKeys()).toEqual(records.slice(1).map((r) => r.session_key));
  });

  it("fails before changing any history when a retained queue or state is invalid", async () => {
    const queue = new LocalQueue(stateDir);
    await queue.overwrite([row("omp")]);
    await writeFile(join(stateDir, "cursors.json"), "{}");
    await writeFile(join(stateDir, "queue.state.json"), "broken");
    await expect(executeReset({ stateDir })).rejects.toThrow("Cannot verify retained queue upload state");
    await expect(executeSync({ stateDir, deviceId: "device" })).rejects.toThrow("Cannot verify retained queue upload state");
    expect((await queue.readFromOffset(0)).records).toEqual([row("omp")]);
    expect(await readFile(join(stateDir, "cursors.json"), "utf8")).toBe("{}");
  });

  it("invalidates both cursors before a failed retained-state write and preserves the original queue", async () => {
    const queue = new LocalQueue(stateDir);
    const records = [row("omp"), row("claude-code")];
    await queue.overwrite(records);
    await writeFile(join(stateDir, "cursors.json"), "{}");
    await writeFile(join(stateDir, "session-cursors.json"), "{}");
    const save = vi.spyOn(BaseQueue.prototype, "saveState").mockRejectedValueOnce(new Error("state write failed"));
    try { await expect(executeReset({ stateDir })).rejects.toThrow("state write failed"); }
    finally { save.mockRestore(); }
    await expect(access(join(stateDir, "cursors.json"))).rejects.toThrow();
    await expect(access(join(stateDir, "session-cursors.json"))).rejects.toThrow();
    expect((await queue.readFromOffset(0)).records).toEqual(records);
  });
});
