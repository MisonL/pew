import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashProjectRef } from "../utils/hash-project-ref.js";
import { decodeAntigravityMetadata, readAntigravitySource, validateAntigravitySession } from "./antigravity.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const dirs: string[] = [];
const writers: Array<{ close(): void }> = [];

function varint(value: number | bigint): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(bytes);
}

function scalar(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function bytes(field: number, value: Uint8Array | string): Buffer {
  const data = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}

function usage(fields: Record<number, number | bigint>): Buffer {
  return Buffer.concat(Object.entries(fields).map(([field, value]) => scalar(Number(field), value)));
}

function metadata(seconds = 1_700_000_000, fields?: Record<number, number | bigint>, nanos = 123_999_999): Buffer {
  return Buffer.concat([
    bytes(1, Buffer.concat([scalar(1, seconds), scalar(2, nanos)])),
    ...(fields ? [bytes(9, usage(fields))] : []),
  ]);
}

function generation(indices: number[], model = "gemini-3.1-pro", packed = true): Buffer {
  const chat = Buffer.concat([bytes(19, model), bytes(4, usage({ 2: 999_999, 3: 999_999 }))]);
  return Buffer.concat([
    bytes(1, chat),
    ...(packed ? [bytes(2, Buffer.concat(indices.map(varint)))] : indices.map((idx) => scalar(2, idx))),
  ]);
}

async function fixture(wal = false) {
  const root = await mkdtemp(join(tmpdir(), "pew-antigravity-test-"));
  dirs.push(root);
  const path = join(root, "conversation.db");
  const db = new DatabaseSync(path);
  writers.push(db);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE trajectory_metadata_blob (data BLOB);
  `);
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES (?)").run(bytes(7, "file:///synthetic/project"));
  const step = (idx: number, data: Uint8Array, type = 15, status = 3) =>
    db.prepare("INSERT INTO steps VALUES (?,?,?,?,?)").run(idx, type, status, data, Buffer.from("private-payload"));
  const gen = (idx: number, indices: number[], model?: string, packed?: boolean) =>
    db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(idx, generation(indices, model, packed));
  return { root, path, db, step, gen };
}

afterEach(async () => {
  for (const writer of writers.splice(0)) writer.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Antigravity private SQLite snapshot", () => {
  it("joins generation step_indices, not table idx, and never counts generation totals", async () => {
    const f = await fixture();
    f.step(0, metadata(1_700_000_000), 14);
    f.step(3, metadata(1_700_000_003, { 1: 999, 2: 100, 3: 30, 4: 0, 5: 20, 9: 7, 10: 23 }));
    f.step(4, metadata(1_700_000_004, { 2: 10, 3: 5, 5: 0 }));
    f.step(5, metadata(1_700_000_005, { 2: 50, 3: 10 }), 15, 1);
    f.step(6, metadata(1_700_000_005), 20);
    f.gen(90, [3, 4]);
    f.gen(91, [3], "gemini-3.1-pro", false);
    const result = await readAntigravitySource(f.root);
    expect(result.dbCount).toBe(1);
    expect(result.deltas).toHaveLength(2);
    expect(result.deltas[0]).toMatchObject({
      source: "antigravity", model: "gemini-3.1-pro", timestamp: "2023-11-14T22:13:23.123Z",
      tokens: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 23, reasoningOutputTokens: 7 },
      accounting: { counts: { input_total_tokens: 120, cache_read_input_tokens: 20, output_total_tokens: 30, reasoning_output_tokens: 7 } },
    });
    expect(result.deltas[1].accounting?.counts?.cache_read_input_tokens).toBe(0);
    expect(result.deltas[1].accounting?.counts?.reasoning_output_tokens).toBe(0);
    expect(result.snapshots).toEqual([expect.objectContaining({
      sessionKey: "antigravity:conversation", source: "antigravity", kind: "human",
      startedAt: "2023-11-14T22:13:20.123Z", lastMessageAt: "2023-11-14T22:13:25.123Z", durationSeconds: 5,
      userMessages: 1, assistantMessages: 3, totalMessages: 4,
      projectRef: hashProjectRef("file:///synthetic/project"), model: "gemini-3.1-pro",
    })]);
    expect(JSON.stringify(result)).not.toContain("private-payload");
    expect(JSON.stringify(result)).not.toContain("file:///synthetic");
    expect((await readAntigravitySource(f.root)).deltas).toEqual(result.deltas);
  });

  it("reads WAL-only changes while leaving the main, WAL and shm byte-identical", async () => {
    const f = await fixture(true);
    f.step(1, metadata(1_700_000_000, { 2: 10, 3: 5 }));
    f.gen(40, [1]);
    const paths = [f.path, `${f.path}-wal`, `${f.path}-shm`];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const result = await readAntigravitySource(f.root);
    expect(result.deltas[0].tokens.inputTokens).toBe(10);
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
    const mainHash = createHash("sha256").update(before[0]).digest("hex");
    f.db.prepare("UPDATE steps SET metadata = ? WHERE idx = 1").run(metadata(1_700_000_000, { 2: 30, 3: 5 }));
    expect(createHash("sha256").update(await readFile(f.path)).digest("hex")).toBe(mainHash);
    expect((await readAntigravitySource(f.root)).deltas[0].tokens.inputTokens).toBe(30);
  });

  it("never opens original files and rejects source mutation during private queries", async () => {
    const f = await fixture();
    f.step(1, metadata(1_700_000_000, { 2: 10, 3: 5 }));
    f.gen(0, [1]);
    let privatePath = "";
    await expect(readAntigravitySource(f.root, (path) => {
      privatePath = path;
      expect(path).not.toBe(f.path);
      expect(basename(path)).toBe("conversation.db");
      f.db.prepare("UPDATE steps SET metadata = ? WHERE idx = 1").run(metadata(1_700_000_000, { 2: 20, 3: 5 }));
      return new DatabaseSync(path, { readOnly: true });
    })).rejects.toThrow(/unstable/i);
    await expect(readFile(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks every earlier database after later databases have been read", async () => {
    const f = await fixture();
    f.step(1, metadata(1_700_000_000, { 2: 10, 3: 5 }));
    f.gen(1, [1]);
    const later = join(f.root, "later.db");
    await writeFile(later, await readFile(f.path));
    await expect(readAntigravitySource(f.root, (path) => {
      if (basename(path) === "later.db") {
        f.db.prepare("UPDATE steps SET metadata = ? WHERE idx = 1").run(metadata(1_700_000_000, { 2: 20, 3: 5 }));
      }
      return new DatabaseSync(path, { readOnly: true });
    })).rejects.toThrow(/unstable/i);
  });

  it("rejects later database mutation relative to the whole-source initial fingerprint", async () => {
    const f = await fixture();
    const later = join(f.root, "later.db");
    await writeFile(later, await readFile(f.path));
    await expect(readAntigravitySource(f.root, (path) => {
      if (basename(path) === "conversation.db") {
        const other = new DatabaseSync(later);
        other.exec("INSERT INTO trajectory_metadata_blob VALUES (X'')");
        other.close();
      }
      return new DatabaseSync(path, { readOnly: true });
    })).rejects.toThrow(/unstable/i);
  });

  it("uses private 0600 copies, never copies shm, and removes copies after open failures", async () => {
    const f = await fixture(true);
    let copy = "";
    await expect(readAntigravitySource(f.root, (path) => {
      copy = path;
      throw new Error("injected open failure");
    })).rejects.toThrow("injected open failure");
    await expect(readFile(copy)).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(f.path, 0o644);
    await readAntigravitySource(f.root, (path) => {
      copy = path;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
      expect(readdirSync(dirname(path))).toEqual(["conversation.db", "conversation.db-wal"]);
      return new DatabaseSync(path, { readOnly: true });
    });
    await expect(readFile(copy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects database directories and symlinks without opening them", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "bad.db"));
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/regular file/i);
    await rm(join(f.root, "bad.db"), { recursive: true });
    await symlink(f.path, join(f.root, "bad.db"));
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/regular file/i);
  });

  it("distinguishes missing roots from an existing empty root", async () => {
    const f = await fixture();
    await expect(readAntigravitySource(join(f.root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    f.db.close();
    writers.splice(writers.indexOf(f.db), 1);
    await rm(f.path);
    await writeFile(join(f.root, "unrelated.txt"), "ignored");
    expect(await readAntigravitySource(f.root)).toEqual({ deltas: [], snapshots: [], dbCount: 0 });
    expect(await readdir(f.root)).toEqual(["unrelated.txt"]);
  });

  it("rejects unsupported SQLite schemas and missing model attribution", async () => {
    const f = await fixture();
    f.step(1, metadata(1_700_000_000, { 2: 10, 3: 5 }));
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/model/i);
    f.db.exec("DROP TABLE gen_metadata");
    await expect(readAntigravitySource(f.root)).rejects.toThrow();
  });

  it("rejects conflicting actual model names for the same usage step", async () => {
    const f = await fixture();
    f.step(1, metadata(1_700_000_000, { 2: 10, 3: 5 }));
    f.gen(80, [1], "first");
    f.gen(81, [1], "second");
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/model/i);
  });

  it.each([
    scalar(1, 1), bytes(1, scalar(19, 1)), bytes(1, bytes(19, "")), bytes(1, bytes(19, "x".repeat(201))),
    bytes(1, bytes(19, "bad\nmodel")), bytes(1, bytes(19, Buffer.from([255]))), bytes(1, bytes(19, "https://private/path")),
    bytes(1, bytes(19, "sk-private")), bytes(1, bytes(19, "unknown")),
    Buffer.concat([bytes(1, bytes(19, "model")), scalar(2, 2_147_483_648)]),
    Buffer.concat([bytes(1, bytes(19, "model")), bytes(2, Buffer.from([128]))]),
    Buffer.concat([bytes(1, bytes(19, "model")), varint(2 * 8 + 5), Buffer.alloc(4)]),
    bytes(2, varint(1)),
  ])("rejects malformed or unknown generation models %#", async (data) => {
    const f = await fixture();
    f.step(1, metadata(1_700_000_000, { 2: 10, 3: 5 }));
    f.db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(1, data);
    await expect(readAntigravitySource(f.root)).rejects.toThrow();
  });

  it("rejects usage without timestamps and ignores completed zero-token steps", async () => {
    const f = await fixture();
    f.step(1, bytes(9, usage({ 2: 10, 3: 5 })));
    f.gen(99, [1]);
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/timestamp/i);
    f.db.prepare("UPDATE steps SET metadata = ?").run(bytes(9, usage({ 2: 0, 3: 0 })));
    expect((await readAntigravitySource(f.root)).deltas).toEqual([]);
  });

  it("rejects invalid SQL row types and database additions during the scan", async () => {
    const f = await fixture();
    f.db.prepare("INSERT INTO steps VALUES (?,?,?,?,?)").run(-1, 15, 3, metadata(), null);
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/step row/i);
    f.db.exec("DELETE FROM steps");
    await expect(readAntigravitySource(f.root, (path) => {
      const source = new DatabaseSync(join(f.root, "new.db"));
      source.close();
      return new DatabaseSync(path, { readOnly: true });
    })).rejects.toThrow(/discovery/i);
  });

  it("hashes nested workspace folder_uri and allows empty sessions", async () => {
    const f = await fixture();
    f.db.prepare("UPDATE trajectory_metadata_blob SET data = ?").run(bytes(1, bytes(1, "file:///another/project")));
    f.step(1, metadata(), 14);
    const result = await readAntigravitySource(f.root);
    expect(result.deltas).toEqual([]);
    expect(result.snapshots[0].projectRef).toBe(hashProjectRef("file:///another/project"));
    f.db.exec("DELETE FROM steps");
    expect((await readAntigravitySource(f.root)).snapshots).toEqual([]);
  });

  it.each([bytes(7, ""), bytes(1, Buffer.alloc(0)), Buffer.alloc(0)])("accepts absent workspace references %#", async (blob) => {
    const f = await fixture();
    f.db.prepare("UPDATE trajectory_metadata_blob SET data = ?").run(blob);
    f.step(1, metadata(), 14);
    expect((await readAntigravitySource(f.root)).snapshots[0].projectRef).toBeNull();
  });

  it("rejects malformed workspace references", async () => {
    const f = await fixture();
    f.db.prepare("UPDATE trajectory_metadata_blob SET data = ?").run(scalar(7, 1));
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/workspace/i);
  });

  it("counts nullable metadata steps without inventing times or usage", async () => {
    const f = await fixture();
    f.step(1, metadata(), 14);
    f.db.prepare("INSERT INTO steps VALUES (?,?,?,?,?)").run(2, 15, 1, null, null);
    expect((await readAntigravitySource(f.root)).snapshots[0]).toMatchObject({ userMessages: 1, assistantMessages: 1, totalMessages: 2 });
  });

  it("rejects sessions with durations beyond the ingest limit before returning token candidates", async () => {
    const f = await fixture();
    f.step(1, metadata(1), 14);
    f.step(2, metadata(315_576_002, { 2: 10, 3: 5 }));
    f.gen(3, [2]);
    await expect(readAntigravitySource(f.root)).rejects.toThrow(/session snapshot/i);
  });

  it("enforces session key, date, duration and message bounds", async () => {
    const f = await fixture();
    f.step(1, metadata(), 14);
    const snapshot = (await readAntigravitySource(f.root)).snapshots[0];
    expect(validateAntigravitySession(snapshot)).toBe(snapshot);
    for (const patch of [
      { sessionKey: "x".repeat(1025) }, { sessionKey: "" }, { model: "x".repeat(1025) },
      { startedAt: "10000-01-01T00:00:00.000Z" }, { snapshotAt: "invalid" },
      { durationSeconds: 315_576_001 }, { durationSeconds: -1 }, { durationSeconds: 0.5 },
      { userMessages: 100_000_001 }, { assistantMessages: -1 }, { totalMessages: 0 },
      { lastMessageAt: "2020-01-01T00:00:00.000Z" },
    ]) expect(() => validateAntigravitySession({ ...snapshot, ...patch })).toThrow(/session snapshot/i);
  });
});

describe("Antigravity Protobuf metadata validation", () => {
  it("recognizes omitted proto3 cache and thinking scalars as known zero", () => {
    expect(decodeAntigravityMetadata(metadata(0, { 2: 10, 3: 5 }, 999_999)).timestamp).toBe("1970-01-01T00:00:00.000Z");
    expect(decodeAntigravityMetadata(metadata(1, { 2: 10, 3: 5 })).usage).toMatchObject({ input: 10, output: 5, read: 0, write: 0, reasoning: 0 });
    expect(decodeAntigravityMetadata(metadata(1, { 2: 10, 3: 5, 5: 0, 9: 0 })).usage).toMatchObject({ read: 0, reasoning: 0 });
  });

  it.each([
    { 2: 1_000_000_001 }, { 2: 1_000_000_000, 5: 1 }, { 2: 1, 3: 1_000_000_000 },
    { 2: 10, 3: 5, 9: 6 }, { 2: 10, 3: 5, 9: 2, 10: 4 }, { 2: 10, 3: 5, 4: 1 },
    { 2: 0xffff_ffff_ffff_ffffn },
  ])("rejects unsafe or contradictory counters %#", (fields) => {
    expect(() => decodeAntigravityMetadata(metadata(1, fields))).toThrow();
  });

  it.each([
    [0], [128], [8, 128], [10, 5, 1], [13, 1], [9, 1], [11], [8, ...Array(10).fill(255)],
    [8, ...Array(9).fill(128), 2], [varint(536_870_912 * 8), 0].flatMap((v) => typeof v === "number" ? [v] : [...v]),
    [13, 1, 2, 3, 4, 99],
  ].map((raw) => ({ raw })))("rejects malformed wire bytes $raw", ({ raw }) => {
    expect(() => decodeAntigravityMetadata(Buffer.from(raw))).toThrow();
  });

  it("rejects invalid timestamps, duplicate singular fields and wrong known wire types", () => {
    expect(() => decodeAntigravityMetadata(metadata(1, undefined, 1_000_000_000))).toThrow();
    expect(() => decodeAntigravityMetadata(metadata(253_402_300_800))).toThrow();
    expect(() => decodeAntigravityMetadata(Buffer.concat([metadata(), metadata()]))).toThrow();
    expect(() => decodeAntigravityMetadata(Buffer.concat([metadata(), scalar(9, 1)]))).toThrow();
    expect(() => decodeAntigravityMetadata(bytes(9, bytes(2, "wrong")))).toThrow();
    expect(() => decodeAntigravityMetadata(bytes(1, bytes(1, "wrong")))).toThrow();
    expect(() => decodeAntigravityMetadata(Buffer.concat([varint(1 * 8 + 1), Buffer.alloc(8)]))).toThrow();
    expect(() => decodeAntigravityMetadata(bytes(1, Buffer.concat([varint(1 * 8 + 5), Buffer.alloc(4)])))).toThrow();
    expect(() => decodeAntigravityMetadata(bytes(1, scalar(1, BigInt.asUintN(64, -62_135_596_801n))))).toThrow();
    expect(() => decodeAntigravityMetadata(null as unknown as Uint8Array)).toThrow();
  });

  it("supports protobuf epoch defaults and signed timestamps", () => {
    expect(decodeAntigravityMetadata(bytes(1, Buffer.alloc(0))).timestamp).toBe("1970-01-01T00:00:00.000Z");
    expect(decodeAntigravityMetadata(bytes(1, scalar(1, BigInt.asUintN(64, -1n)))).timestamp).toBe("1969-12-31T23:59:59.000Z");
    expect(decodeAntigravityMetadata(bytes(9, Buffer.alloc(0))).usage).toMatchObject({ input: 0, output: 0 });
  });

  it("skips unknown opaque, fixed32 and fixed64 fields without decoding their contents", () => {
    const decoded = decodeAntigravityMetadata(Buffer.concat([
      metadata(1, { 2: 10, 3: 5 }), bytes(50, Buffer.from([255, 255])),
      varint(51 * 8 + 1), Buffer.alloc(8), varint(52 * 8 + 5), Buffer.alloc(4), scalar(53, 1),
    ]));
    expect(decoded.usage?.input).toBe(10);
  });
});
