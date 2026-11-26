import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCursorStore } from "../storage/session-cursor-store.js";

describe("SessionCursorStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pew-session-cursor-store-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty state when the file has no usable files map", async () => {
    // `null` and `{}` both used to reach `Object.entries(cursors.files)` in
    // session-sync and crash the whole session sync with a TypeError.
    const store = new SessionCursorStore(tempDir);
    for (const body of ["null", "{}", '{"version":1,"files":null}', '{"version":1,"files":[]}']) {
      await writeFile(join(tempDir, "session-cursors.json"), body);
      expect(await store.load()).toEqual({ version: 1, files: {}, updatedAt: null });
    }
  });

  it("drops a per-file entry that is not a cursor object", async () => {
    // A non-object entry makes shouldSkip() compare against undefined fields,
    // so the file counts as changed and is re-scanned — harmless for sessions
    // (dedup is by session_key) but it is still damaged state; dropping it
    // keeps `Object.keys(cursors.files)` honest for status reporting.
    await writeFile(
      join(tempDir, "session-cursors.json"),
      JSON.stringify({
        version: 1,
        files: {
          "/good": { mtimeMs: 1, size: 2 },
          "/bad": 5,
          "/null": null,
          "/arr": [],
        },
      }),
    );
    const state = await new SessionCursorStore(tempDir).load();
    expect(Object.keys(state.files)).toEqual(["/good"]);
  });

  it("keeps a directory cursor that has no size", async () => {
    // OpenCode JSON session cursors are mtime-only by design.
    await writeFile(
      join(tempDir, "session-cursors.json"),
      JSON.stringify({ version: 1, files: { "/dir": { mtimeMs: 1 } } }),
    );
    const state = await new SessionCursorStore(tempDir).load();
    expect(state.files["/dir"]).toEqual({ mtimeMs: 1 });
  });

  it("drops an openCodeSqlite cursor whose nested fields have the wrong type", async () => {
    // The driver feeds lastTimeUpdated into `WHERE time_updated >= ?` and
    // rebuilds a Set from lastProcessedIds. A string watermark makes every
    // comparison false (TEXT sorts above every integer) and is written back
    // forever, so the source silently collects nothing; a non-iterable id
    // list throws a TypeError the per-driver catch can only warn about every
    // run. Either way the damaged cursor never heals without hand-deleting
    // the state file — the other stores drop damaged entries instead.
    const cases = [
      { lastTimeUpdated: "corrupt", lastProcessedIds: [], inode: 1, updatedAt: "t" },
      { lastTimeUpdated: 1, lastProcessedIds: 42, inode: 1, updatedAt: "t" },
      { lastTimeUpdated: 1, lastProcessedIds: ["a", 2], inode: 1, updatedAt: "t" },
      { lastTimeUpdated: 1, lastProcessedIds: [], inode: "x", updatedAt: "t" },
      { lastTimeUpdated: -1, lastProcessedIds: [], inode: 1, updatedAt: "t" },
      { lastTimeUpdated: 1, lastProcessedIds: [], inode: 1, updatedAt: 5 },
    ];
    for (const openCodeSqlite of cases) {
      await writeFile(
        join(tempDir, "session-cursors.json"),
        JSON.stringify({ version: 1, files: { "/keep": { mtimeMs: 1 } }, openCodeSqlite }),
      );
      const state = await new SessionCursorStore(tempDir).load();
      expect(state.openCodeSqlite, JSON.stringify(openCodeSqlite)).toBeUndefined();
      // The damage is scoped: valid file cursors still load.
      expect(Object.keys(state.files)).toEqual(["/keep"]);
    }
  });

  it("keeps a well-formed openCodeSqlite cursor", async () => {
    const cursor = { lastTimeUpdated: 5, lastProcessedIds: ["s1"], inode: 7, updatedAt: "2026-11-26T00:00:00Z" };
    await writeFile(
      join(tempDir, "session-cursors.json"),
      JSON.stringify({ version: 1, files: {}, openCodeSqlite: cursor }),
    );
    const state = await new SessionCursorStore(tempDir).load();
    expect(state.openCodeSqlite).toEqual(cursor);
  });
});
