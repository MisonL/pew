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
