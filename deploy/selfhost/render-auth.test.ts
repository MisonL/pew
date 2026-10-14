import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// vitest runs ESM here, so import.meta.dir (Bun-only) is undefined; same as
// deterministic-revision.test.ts.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "render-rqlite-auth.sh");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => { rmSync(d, { recursive: true, force: true }); }));

function run(env: Record<string, string>, outDir: string) {
  // Whitelist the environment (M1, review round 2): inheriting {...process.env}
  // leaks host variables (e.g. RQLITE_* exported via `set -a; . ./.env`), which
  // can turn the negative paths into false failures or false passes.
  const child = spawn("bash", [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
      AUTH_OUT_FILE: join(outDir, ".rqlite-auth.json"),
    },
    stdio: "pipe",
  });
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

// Run the script with a stripped-down PATH (bash resolved by absolute path so
// spawn itself still works). Used for the jq-missing negative path.
function runWithoutPath(outDir: string) {
  const child = spawn("/bin/bash", [SCRIPT], {
    env: {
      RQLITE_USERNAME: "pew",
      RQLITE_PASSWORD: "pw1",
      RQLITE_JOIN_PASSWORD: "pw2",
      AUTH_OUT_FILE: join(outDir, ".rqlite-auth.json"),
      PATH: "/nonexistent",
    },
    stdio: "pipe",
  });
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe("render-rqlite-auth.sh", () => {
  it("renders all three entries with 0600 perms when all three vars are set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const p = run({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1", RQLITE_JOIN_PASSWORD: "pw2" }, dir);
    expect((await p).code).toBe(0);
    const file = join(dir, ".rqlite-auth.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    const names = parsed.map((u: { username: string }) => u.username);
    // No pew-ro: rqlite 10.5.3 has no "select" permission name and
    // read/scheduler carry /db/request write paths, so it was removed.
    expect(names).toEqual(["pew", "joiner", "*"]);
    expect(parsed.find((u: { username: string }) => u.username === "*").perms).toEqual(["status", "ready"]);
    expect(parsed.find((u: { username: string }) => u.username === "joiner").password).toBe("pw2");
    expect(parsed.find((u: { username: string }) => u.username === "pew").perms).toEqual(["all"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("errors and removes any stale file when a variable is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const file = join(dir, ".rqlite-auth.json");
    // Stale file left over from a previous run.
    writeFileSync(file, "stale");
    const p = run({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1" }, dir); // no JOIN password
    expect((await p).code).not.toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("errors and removes a stale directory when a variable is missing (bind-mount trap)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const file = join(dir, ".rqlite-auth.json");
    // Pre-create a stale DIRECTORY — docker creates one for a missing
    // bind-mount source file, so the script must rm -rf it too.
    mkdirSync(file);
    const p = run({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1" }, dir); // no JOIN password
    expect((await p).code).not.toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("removes leftovers when all vars are empty (default-off path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const file = join(dir, ".rqlite-auth.json");
    writeFileSync(file, "stale");
    const p = run({}, dir);
    expect((await p).code).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a dangerous AUTH_OUT_FILE instead of rm -rf'ing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const child = spawn("/bin/bash", [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1", RQLITE_JOIN_PASSWORD: "pw2",
        AUTH_OUT_FILE: "/etc",
      },
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing dangerous AUTH_OUT_FILE");
  });

  it("removes a stale DIRECTORY before rendering and still succeeds (N1 success-path trap)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const file = join(dir, ".rqlite-auth.json");
    // If $OUT is a directory, `mv OUT.tmp OUT` moves INTO it and chmod exits 0
    // on the directory — the entrypoint would silently start without auth.
    mkdirSync(file);
    const p = run({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1", RQLITE_JOIN_PASSWORD: "pw2" }, dir);
    expect((await p).code).toBe(0);
    expect(statSync(file).isFile()).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a dangerous AUTH_OUT_FILE even with duplicate leading slashes (S1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const child = spawn("/bin/bash", [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1", RQLITE_JOIN_PASSWORD: "pw2",
        AUTH_OUT_FILE: "//etc",
      },
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing dangerous AUTH_OUT_FILE");
  });

  it("errors and leaves no .tmp residue when jq is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const file = join(dir, ".rqlite-auth.json");
    const { code, stderr } = await runWithoutPath(dir);
    expect(code).not.toBe(0);
    expect(stderr).toContain("jq is required");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
