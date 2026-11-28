import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMessageDb } from "../parsers/opencode-sqlite-db.js";
import { openSessionDb } from "../parsers/opencode-sqlite-db.js";
import { processOpenCodeMessages } from "../parsers/opencode-sqlite.js";

/**
 * A `data` blob that is not valid JSON must not take the whole source down.
 *
 * The queries used to call `json_extract(data, '$.role')` inline; SQLite raises
 * "malformed JSON" for a corrupt blob, so the statement threw before any row
 * reached the row-level `skippedCorrupt` counting — the driver caught the
 * error, skipped OpenCode for the run, and retried forever (the cursor never
 * advanced). These tests go through the real SQLite statements, not mocked
 * rows, so the corrupt-blob shape is exercised the way production sees it.
 */

// node:sqlite is what the module picks under Node (vitest's runtime here).
async function makeDb(): Promise<{ DatabaseSync: new (path: string) => {
  exec(sql: string): void; close(): void;
} }> {
  const mod = await import("node:sqlite");
  return mod as never;
}

describe("opencode SQLite corrupt data blobs", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pew-opencode-corrupt-"));
    dbPath = join(dir, "opencode.db");
    const { DatabaseSync } = await makeDb();
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER)`);
    db.exec(`CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`);
    db.exec(`INSERT INTO session VALUES ('s1', 'p', 't', 1770000000000, 1770000001000)`);
    db.exec(`INSERT INTO message VALUES
      ('m1', 's1', 1770000000000, '{"role":"user","time":{"created":1770000000000}}')`);
    db.exec(`INSERT INTO message VALUES ('m2', 's1', 1770000001000, '{not json')`);
    db.close();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("queryMessages returns corrupt rows as role=null instead of throwing", () => {
    const handle = openMessageDb(dbPath);
    expect(handle).not.toBeNull();
    try {
      const rows = handle?.queryMessages(0) ?? [];
      expect(rows).toHaveLength(2);
      const corrupt = rows.find((r) => r.id === "m2");
      expect(corrupt?.role).toBeNull();
      // The row-level counter from the round-59 fix now actually sees it.
      const result = processOpenCodeMessages(rows);
      expect(result.skippedCorrupt).toBe(1);
    } finally {
      handle?.close();
    }
  });

  it("querySessionMessages returns corrupt rows instead of throwing", () => {
    const handle = openSessionDb(dbPath);
    expect(handle).not.toBeNull();
    try {
      const rows = handle?.querySessionMessages(["s1"]) ?? [];
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.session_id === "s1" && r.data === "{not json")?.role).toBeNull();
    } finally {
      handle?.close();
    }
  });
});
