import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { splitStatements } from "./migrate";

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/migrations/031-selfhost-infrastructure.sql"
);

describe("031-selfhost-infrastructure.sql", () => {
  it("creates the kv_cache table the KV adapter depends on", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const statements = splitStatements(sql).join("\n");
    expect(statements).toMatch(/CREATE TABLE IF NOT EXISTS\s+kv_cache/i);
    expect(statements).toMatch(/key\s+TEXT\s+PRIMARY KEY/i);
    expect(statements).toMatch(/value\s+TEXT\s+NOT NULL/i);
    expect(statements).toMatch(/expires_at\s+TEXT/i);
  });

  it("is idempotent so re-running the migration set is safe", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const statements = splitStatements(sql);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, `not idempotent: ${statement.slice(0, 60)}`).toMatch(
        /IF NOT EXISTS/i
      );
    }
  });

  it("does not use non-deterministic defaults", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).not.toMatch(/DEFAULT\s*\(\s*datetime\s*\(\s*'now'/i);
    expect(sql).not.toMatch(/randomblob\s*\(/i);
  });
});
