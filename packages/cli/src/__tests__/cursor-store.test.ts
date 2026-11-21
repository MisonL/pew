import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorStore } from "../storage/cursor-store.js";
import type { ByteOffsetCursor, CursorState } from "@pew/core";

describe("CursorStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pew-cursor-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should return empty state when no file exists", async () => {
    const store = new CursorStore(tempDir);
    const state = await store.load();
    expect(state.version).toBe(1);
    expect(state.files).toEqual({});
    expect(state.updatedAt).toBeNull();
  });

  it("should save and load cursor state", async () => {
    const store = new CursorStore(tempDir);
    const cursor: ByteOffsetCursor = {
      inode: 123,
      offset: 4096,
      updatedAt: "2026-03-07T10:00:00Z",
    };
    const state: CursorState = {
      version: 1,
      files: { "/path/to/file.jsonl": cursor },
      updatedAt: "2026-03-07T10:00:00Z",
    };
    await store.save(state);
    const loaded = await store.load();
    expect(loaded.files["/path/to/file.jsonl"]).toEqual(cursor);
    expect(loaded.updatedAt).toBe("2026-03-07T10:00:00Z");
  });

  it("should create directory if it does not exist", async () => {
    const nestedDir = join(tempDir, "deep", "nested");
    const store = new CursorStore(nestedDir);
    await store.save({
      version: 1,
      files: {},
      updatedAt: null,
    });
    const loaded = await store.load();
    expect(loaded.version).toBe(1);
  });

  it("should persist valid JSON to disk", async () => {
    const store = new CursorStore(tempDir);
    await store.save({
      version: 1,
      files: { "/test": { inode: 1, offset: 0, updatedAt: "2026-01-01T00:00:00Z" } },
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const raw = await readFile(join(tempDir, "cursors.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.files["/test"].inode).toBe(1);
  });

  it("should handle corrupted file gracefully", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "cursors.json"), "corrupted{{{");
    const store = new CursorStore(tempDir);
    const state = await store.load();
    expect(state.version).toBe(1);
    expect(state.files).toEqual({});
  });

  it("falls back to an empty state when the parsed cursor file has no usable files map", async () => {
    // `null`, an array and a bare string are handled by the base store, but an
    // OBJECT without `files` slipped through and crashed the sync loop at
    // `Object.entries(cursors.files)` — every source, not just the damaged
    // file. A full rescan is the documented recovery for lost cursors.
    const { writeFile } = await import("node:fs/promises");
    const store = new CursorStore(tempDir);
    for (const body of ['{"version":1}', '{"version":1,"files":null}', '{"version":1,"files":"abc"}', '{"version":1,"files":[]}']) {
      await writeFile(join(tempDir, "cursors.json"), body);
      const state = await store.load();
      expect(state.files).toEqual({});
      expect(state.version).toBe(1);
    }
  });

  it("drops a per-file entry that is not a cursor object", async () => {
    // A non-object entry reads as "changed" with startOffset 0, which re-reads
    // the whole file and SUMs it onto the pending queue — double counting. As
    // an absent entry for a known path it instead triggers the full-rescan
    // recovery, which overwrites rather than adds.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tempDir, "cursors.json"),
      JSON.stringify({
        version: 1,
        files: { "/good": { inode: 1, offset: 10, updatedAt: "x" }, "/bad": 5, "/null": null, "/arr": [] },
        knownFilePaths: { "/good": true, "/bad": true, "/null": true, "/arr": true },
      }),
    );
    const state = await new CursorStore(tempDir).load();
    expect(Object.keys(state.files)).toEqual(["/good"]);
    // Dropping the entry alone would make it look like a new file.
    expect(state.knownFilePaths).toEqual({ "/good": true, "/bad": true, "/null": true, "/arr": true });
  });

  it("does not add knownFilePaths to a file that never had one", async () => {
    // Its absence is the marker for the pre-v1.6.0 one-time full-rescan
    // upgrade; adding an empty map here would silently skip that migration.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tempDir, "cursors.json"),
      JSON.stringify({ version: 1, files: { "/bad": 5 } }),
    );
    const state = await new CursorStore(tempDir).load();
    expect(state.files).toEqual({});
    expect(state.knownFilePaths).toBeUndefined();
  });

  it("drops a per-file entry whose dedup ring is not a list of ids", async () => {
    // Claude's preload() iterates `seenIds` into the per-run Set: a number
    // threw "ids is not iterable" and a non-string entry put a bogus id in the
    // Set. Both took down every source, not just the damaged file.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tempDir, "cursors.json"),
      JSON.stringify({
        version: 1,
        files: {
          "/good": { inode: 1, offset: 10, seenIds: ["a", "b"], updatedAt: "x" },
          "/number": { inode: 1, offset: 10, seenIds: 5, updatedAt: "x" },
          "/entries": { inode: 1, offset: 10, seenIds: [5], updatedAt: "x" },
        },
        knownFilePaths: { "/good": true, "/number": true, "/entries": true },
      }),
    );
    const state = await new CursorStore(tempDir).load();
    expect(Object.keys(state.files)).toEqual(["/good"]);
    expect(state.knownFilePaths).toEqual({ "/good": true, "/number": true, "/entries": true });
  });

  it("discards the state when a codex scope's usage-key set is not iterable", async () => {
    // The scan seeds ctx.codexSeenUsageKeys with `new Set(scope.usageKeys)`;
    // a non-iterable value threw "number 5 is not iterable" before any file
    // was read, on every later run too.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tempDir, "cursors.json"),
      JSON.stringify({
        version: 1, files: {}, knownFilePaths: {}, accountingSchemaVersion: 2,
        codexScopes: { scope: { totals: null, usageKeys: 5 } },
      }),
    );
    expect(await new CursorStore(tempDir).load()).toEqual({ version: 1, files: {}, updatedAt: null });
  });

  it("discards the whole state when an optional field has the wrong type", async () => {
    // hermesSqlite: 5 crashed with "Cannot use 'in' operator … in 5"; the other
    // fields are only read through Object.entries/Object.keys, so a wrong type
    // there is silent nonsense rather than a crash. Partial repair is not safe:
    // keeping `files` while dropping `codexScopes` loses the cross-rollout
    // high-water marks that stop a shared cumulative counter from counting
    // twice. A full rescan overwrites the queue instead, which is the
    // documented recovery for a lost cursor.
    const { writeFile } = await import("node:fs/promises");
    const store = new CursorStore(tempDir);
    const fields = {
      hermesSqlite: 5, knownFilePaths: 7, knownDbSources: [], dirMtimes: "x",
      codexScopes: 0, openCodeSqlite: "y", antigravity: 1, accountingSchemaVersion: "v2",
    };
    for (const [name, bad] of Object.entries(fields)) {
      await writeFile(
        join(tempDir, "cursors.json"),
        JSON.stringify({ version: 1, files: { "/good": { inode: 1, offset: 10, updatedAt: "x" } }, updatedAt: "x", [name]: bad }),
      );
      expect(await store.load()).toEqual({ version: 1, files: {}, updatedAt: null });
    }
    await writeFile(
      join(tempDir, "cursors.json"),
      JSON.stringify({ version: 1, files: { "/good": { inode: 1, offset: 10, updatedAt: "x" } }, updatedAt: 9 }),
    );
    expect(await store.load()).toEqual({ version: 1, files: {}, updatedAt: null });
  });

  it("drops a per-file entry whose resume fields are not numbers", async () => {
    // A string offset/size becomes NaN in comparisons and in
    // createReadStream's start option; a non-numeric lastTotals turns the
    // cumulative diff into NaN, which reaches the server after the cursor
    // already moved past the bytes.
    const { writeFile } = await import("node:fs/promises");
    const good = { inode:1, offset:10, size:20, mtimeMs:30, updatedAt: "x" };
    await writeFile(
      join(tempDir, "cursors.json"),
      JSON.stringify({
        version:1,
        files: {
          "/good": good,
          "/offset": { ...good, offset: "10" },
          "/size": { ...good, size: "20" },
          "/totals": { ...good, lastTotals: { inputTokens: "1", cachedInputTokens:0, outputTokens:0, reasoningOutputTokens:0 } },
          "/anchors": { ...good, continuityAnchors: [{ sha256: "a", length: "1" }] },
          "/ctx": { ...good, accountingContext: { provider:5 } },
        },
        knownFilePaths: { "/good": true, "/offset": true, "/size": true, "/totals": true, "/anchors": true, "/ctx": true },
      }),
    );
    const state = await new CursorStore(tempDir).load();
    expect(Object.keys(state.files)).toEqual(["/good"]);
  });

  it("discards the state when a DB cursor carries non-numeric epochs", async () => {
    // lastTimeCreated / lastSessionUpdated / dbCount are compared against
    // every row of the incremental query; a string reads as NaN and the
    // source either re-reads everything or skips it forever.
    const { writeFile } = await import("node:fs/promises");
    const variants: Array<Record<string, unknown>> = [
      { openCodeSqlite: { lastTimeCreated: "x", lastSessionUpdated:1, inode:1, updatedAt: "x" } },
      { antigravity: { dbCount: "1", updatedAt: "x" } },
      { hermesSqlite: { default: { inode:1, updatedAt: "x", sessionTotals: { s: { input: "1", output:1, cacheRead:1, cacheWrite:1, reasoning:1 } } } } },
      { dirMtimes: { "/dir": "x" } },
      { codexScopes: { s: { totals: { inputTokens: "1" }, usageKeys: [] } } },
    ];
    const store = new CursorStore(tempDir);
    for (const extra of variants) {
      await writeFile(
        join(tempDir, "cursors.json"),
        JSON.stringify({ version:1, files: {}, updatedAt: "x", ...extra }),
      );
      expect(await store.load(), JSON.stringify(extra)).toEqual({ version:1, files: {}, updatedAt: null });
    }
  });
  it("keeps a pre-multi-profile flat hermes cursor", async () => {
    // sync.ts detects this shape and migrates it to { default: cursor } on
    // first access; rejecting it here would silently reset every Hermes
    // baseline and re-count its session totals.
    const { writeFile } = await import("node:fs/promises");
    const flat = {
      inode:1,
      updatedAt: "x",
      sessionTotals: { s: { input:1, output:2, cacheRead:3, cacheWrite:4, reasoning:5 } },
    };
    await writeFile(
      join(tempDir, "cursors.json"),
      JSON.stringify({ version:1, files: {}, updatedAt: "x", hermesSqlite: flat }),
    );
    const state = await new CursorStore(tempDir).load();
    expect(state.hermesSqlite).toEqual(flat);
  });
  it("should get a specific file cursor", async () => {
    const store = new CursorStore(tempDir);
    const cursor: ByteOffsetCursor = {
      inode: 42,
      offset: 100,
      updatedAt: "2026-03-07T10:00:00Z",
    };
    await store.save({
      version: 1,
      files: { "/my/file": cursor },
      updatedAt: "2026-03-07T10:00:00Z",
    });
    const loaded = await store.load();
    const fileCursor = loaded.files["/my/file"];
    expect(fileCursor).toEqual(cursor);
  });

  it("should return undefined for unknown file cursor", async () => {
    const store = new CursorStore(tempDir);
    const state = await store.load();
    expect(state.files["/nonexistent"]).toBeUndefined();
  });

  it("should expose filePath", () => {
    const store = new CursorStore(tempDir);
    expect(store.filePath).toBe(join(tempDir, "cursors.json"));
  });
});
