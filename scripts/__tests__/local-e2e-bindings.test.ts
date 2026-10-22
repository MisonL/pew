import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { localIsolatedEnv, verifyLocalMarker } from "../local-e2e-bindings";

// rmSync is wrapped so one test can force a cleanup failure; every other
// caller keeps the real implementation.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

afterEach(() => vi.unstubAllGlobals());

describe("local D1 marker", () => {
  const env = {
    NODE_ENV: "development", RESOURCE_ENV: "test", E2E_SKIP_AUTH: "true",
    CF_ACCOUNT_ID: "pew-local-test", CF_D1_DATABASE_ID: "pew-local-test", CF_D1_API_TOKEN: "synthetic",
    PEW_LOCAL_D1_URL: "http://127.0.0.1:12345", WORKER_INGEST_URL: "http://127.0.0.1:12345/ingest",
    WORKER_READ_URL: "http://127.0.0.1:12345", PEW_TEST_RUN_ID: "owned-run",
  };
  it.each([{ rows: [] }, { rows: [{ key: "env", value: "production" }, { key: "run", value: "owned-run" }] }, { rows: [{ key: "env", value: "test" }, { key: "run", value: "other-run" }] }])("rejects missing or wrong SQL marker %j", async ({ rows }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, result: [{ results: rows }] })));
    await expect(verifyLocalMarker(env)).rejects.toThrow("_test_marker");
  });
  it("queries the actual DB marker rather than /api/live", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, result: [{ results: [{ key: "env", value: "test" }, { key: "run", value: "owned-run" }] }] }));
    vi.stubGlobal("fetch", fetcher);
    await verifyLocalMarker(env);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${env.PEW_LOCAL_D1_URL}/query`);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).sql).toContain("FROM _test_marker");
    await expect(verifyLocalMarker({ ...env, WORKER_READ_URL: "https://production.invalid" })).rejects.toThrow("same isolated");
    await expect(verifyLocalMarker({ ...env, PEW_TEST_RUN_ID: "" })).rejects.toThrow("configuration missing");
  });
});

describe("real D1 lifecycle", () => {
  it("disables the migration CLI banner's network update check", async () => {
    for (const key of ["HOME", "XDG_CONFIG_HOME", "WRANGLER_SEND_METRICS"]) vi.stubEnv(key, process.env[key]);
    const spawn = vi.fn(() => ({
      stdout: new Response("").body,
      stderr: new Response("synthetic migration failure").body,
      exited: Promise.resolve(1),
    }));
    vi.stubGlobal("Bun", { spawn });
    try {
      await expect(localIsolatedEnv()).rejects.toThrow("synthetic migration failure");
      expect(spawn).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
        env: expect.objectContaining({ WRANGLER_HIDE_BANNER: "true", WRANGLER_SEND_METRICS: "false" }),
      }));
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it("keeps the startup error when cleanup also fails", async () => {
    // Migration spawn fails (startup error) AND dispose's rmSync fails
    // (cleanup error): the startup error must stay errors[0], never replaced
    // by "Local D1 cleanup failed" (same rule as startLocalBindings).
    for (const key of ["HOME", "XDG_CONFIG_HOME", "WRANGLER_SEND_METRICS"]) vi.stubEnv(key, process.env[key]);
    // A failed removal deliberately leaves the state dir behind. Point TMPDIR
    // at a private root so cleanup deletes only this test's directory: the
    // real lanes and other vitest workers create `pew-e2e-*` siblings in the
    // shared tmpdir, and a prefix-based sweep would delete a live lane's
    // state.
    const root = mkdtempSync(join(tmpdir(), "pew-bindings-leak-"));
    vi.stubEnv("TMPDIR", root);
    const rm = vi.mocked((await import("node:fs")).rmSync).mockImplementation(() => {
      throw new Error("synthetic rm failure");
    });
    vi.stubGlobal("Bun", {
      spawn: vi.fn(() => ({ stdout: new Response("").body, stderr: new Response("synthetic migration failure").body, exited: Promise.resolve(1) })),
    });
    try {
      const error = await localIsolatedEnv().then(() => undefined, (rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe("Local D1 startup failed and cleanup also failed");
      expect((aggregate.errors[0] as Error).message).toContain("synthetic migration failure");
      expect((aggregate.errors[1] as Error).message).toContain("Local D1 cleanup failed");
      // The leaked state dir really was created under the private root (the
      // assertion would otherwise pass vacuously if the stub were ignored).
      expect(readdirSync(root).filter((name) => name.startsWith("pew-e2e-"))).toHaveLength(1);
    } finally {
      rm.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves full fresh schema, native Worker RPC and failure cleanup", () => {
    // Beneath the coverage suite this spawn can take well over 100s; the
    // timeout budget is deliberately generous (the old 120s ceiling failed
    // for reasons unrelated to the migration itself).
    const result = spawnSync("bun", ["--no-env-file", "scripts/test-local-e2e.ts"], { encoding: "utf8", timeout: 900_000, env: { ...process.env, CI: "true", PEW_SYNTHETIC_PARENT_SECRET: "must-not-forward" } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 900_000);
  it.each(["THIS IS NOT SQL;", "CREATE TABLE duplicate(id TEXT); CREATE TABLE duplicate(id TEXT);"])("fails invalid or duplicate SQL and cleans only fresh state: %s", (sql) => {
    const migrations = mkdtempSync(join(tmpdir(), "pew-invalid-migration-"));
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pew-e2e-")));
    try {
      writeFileSync(join(migrations, "0001.sql"), sql);
      const result = spawnSync("bun", ["--no-env-file", "-e", 'import {localIsolatedEnv} from "./scripts/local-e2e-bindings.ts"; await localIsolatedEnv(process.argv[1]);', migrations], { encoding: "utf8", timeout: 120_000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("migrations failed");
      expect(new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pew-e2e-")))).toEqual(before);
      expect(existsSync(migrations)).toBe(true);
    } finally { rmSync(migrations, { recursive: true }); }
  }, 300_000);
});
