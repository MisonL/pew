import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/migrations/032-auth-credentials.sql"
);

describe("032-auth-credentials.sql", () => {
  it("adds password_hash and is_admin to users", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN password_hash TEXT/i);
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0/i);
  });

  it("creates the single-row instance_setup claim table", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS instance_setup/i);
    expect(sql).toMatch(/CHECK \(id\s*=\s*1\)/i);
  });

  it("creates a password_resets table with an expiry", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS password_resets/i);
    expect(sql).toMatch(/expires_at\s+TEXT/i);
  });

  it("does not rely on non-deterministic column defaults", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    expect(sql).not.toMatch(/DEFAULT\s*\(\s*datetime\s*\(\s*'now'/i);
    expect(sql).not.toMatch(/randomblob\s*\(/i);
  });
});
