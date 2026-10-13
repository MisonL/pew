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
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(env: Record<string, string>, outDir: string) {
  const child = spawn("bash", [SCRIPT], {
    env: { ...process.env, ...env, AUTH_OUT_FILE: join(outDir, ".rqlite-auth.json") },
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
  it("renders all four entries with 0600 perms when all three vars are set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-")); dirs.push(dir);
    const p = run({ RQLITE_USERNAME: "pew", RQLITE_PASSWORD: "pw1", RQLITE_JOIN_PASSWORD: "pw2" }, dir);
    expect((await p).code).toBe(0);
    const file = join(dir, ".rqlite-auth.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    const names = parsed.map((u: { username: string }) => u.username);
    expect(names).toEqual(["pew", "pew-ro", "joiner", "*"]);
    expect(parsed.find((u: { username: string }) => u.username === "pew-ro").perms).toEqual(["select"]);
    expect(parsed.find((u: { username: string }) => u.username === "*").perms).toEqual(["status", "ready"]);
    expect(parsed.find((u: { username: string }) => u.username === "joiner").password).toBe("pw2");
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
});
