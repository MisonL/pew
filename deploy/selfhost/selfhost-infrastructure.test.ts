import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

describe("rqlite auth wiring (spec Plan 3 §3.1.2)", () => {
  // vitest runs ESM in Node, so import.meta.dir (Bun-only) is undefined; same
  // pattern as deterministic-revision.test.ts and render-auth.test.ts.
  const compose = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "docker-compose.yml"), "utf8");

  it("wraps every rqlite service with the entrypoint script and auth mount", () => {
    expect(compose).toContain('entrypoint: ["sh", "/entrypoint.sh"]');
    expect(compose.match(/\.\/rqlite-entrypoint\.sh:\/entrypoint\.sh:ro/g)?.length).toBe(4);
    expect(compose.match(/\.\/\.rqlite-auth\.json:\/auth\/auth\.json:ro/g)?.length).toBe(4);
  });

  it("cluster nodes join as the dedicated joiner user; single node does not", () => {
    const cluster = compose.slice(compose.indexOf("rqlite-1:"), compose.indexOf("migrate:"));
    expect(cluster.match(/RQLITE_JOIN_AS: joiner/g)?.length).toBe(3);
    const single = compose.slice(compose.indexOf("  rqlite:"), compose.indexOf("  rqlite-1:"));
    expect(single).not.toContain("RQLITE_JOIN_AS");
  });

  it("write services get full credentials; read/scheduler get read-only ones", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose var-expansion literal, not interpolation
    expect(compose).toContain("RQLITE_USERNAME: ${RQLITE_USERNAME:-}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose var-expansion literal, not interpolation
    expect(compose).toContain("RQLITE_READ_USERNAME: ${RQLITE_READ_USERNAME:-}");
    const sched = compose.slice(compose.indexOf("  scheduler:"), compose.indexOf("  web:"));
    expect(sched).toContain("RQLITE_READ_USERNAME");
    // Relaxed (review round 2): scheduler now ALSO receives the full
    // RQLITE_USERNAME/PASSWORD pair so the server-side READ_* fallback works
    // (resolveReadBasicAuth). The remaining checkable minimal-exposure intent:
    // no d1-http verifier token and no ingest secret injected into scheduler.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose var-expansion literal, not interpolation
    expect(sched).not.toContain("CF_D1_API_TOKEN: ${CF_D1_API_TOKEN}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose var-expansion literal, not interpolation
    expect(sched).not.toContain("WORKER_SECRET: ${WORKER_SECRET}");
  });

  it("ignores the rendered auth file in git and docker contexts", () => {
    expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../.gitignore"), "utf8"))
      .toContain("deploy/selfhost/.rqlite-auth.json");
    expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../.dockerignore"), "utf8"))
      .toContain("**/.rqlite-auth.json");
  });
});
