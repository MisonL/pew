import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "backup.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Runs backup.sh against a fake `docker` on PATH that records its argv and
 * simulates `compose exec` (REPL transcript in/out) and `compose cp`.
 */
function run(opts: {
  env?: Record<string, string>;
  archiveBytes?: number;
  profile?: string;
  args?: string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), "bk-")); dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // backup.sh cd's to its own directory (production layout: script next to
  // .env), so the script copy — not the real deploy/selfhost/.env — anchors
  // the run inside the temp dir.
  const script = join(dir, "backup.sh");
  copyFileSync(SCRIPT, script);
  const log = join(dir, "docker.log");
  const archive = join(dir, "archive.db");
  writeFileSync(archive, Buffer.alloc(opts.archiveBytes ?? 64, 7));
  const fakeDocker = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  *"exec"*"rm -f"*) exit 0;;
  *"exec"*) cat > /dev/null; exit 0;;
  *"cp"*)
    # $* = compose cp <svc>:<path> <out> — last arg is the destination.
    for last in "$@"; do :; done
    cp ${JSON.stringify(archive)} "$last"
    exit 0;;
esac
exit 0
`;
  writeFileSync(join(bin, "docker"), fakeDocker);
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(dir, ".env"), `COMPOSE_PROFILES=${opts.profile ?? "single"}\nRQLITE_USERNAME=pew\nRQLITE_PASSWORD='pw with spaces'\n`);
  const out = join(dir, "out.db");
  const child = spawn("bash", [script, out], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<{ code: number; stderr: string; log: string; out: string }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({
      code: code ?? -1,
      stderr,
      log: existsSync(log) ? readFileSync(log, "utf8") : "",
      out,
    }));
  });
}

describe("backup.sh", () => {
  it("backs up via the single-node service, chmods the archive and exits 0", async () => {
    const r = await run({});
    expect(r.code, r.stderr).toBe(0);
    expect(r.log).toContain("compose exec -T rqlite rqlite -u pew:pw with spaces -H localhost");
    expect(r.log).toContain("compose cp rqlite:/rqlite/file/backup.db");
    // The in-container copy is cleaned up before success is reported.
    expect(r.log).toContain("compose exec -T rqlite rm -f /rqlite/file/backup.db");
    expect(existsSync(r.out)).toBe(true);
    // 0600: the archive carries every password_hash.
    expect(statSync(r.out).mode & 0o777).toBe(0o600);
  });

  it("targets rqlite-1 under the cluster profile (no rqlite service there)", async () => {
    const r = await run({ profile: "cluster" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.log).toContain("compose exec -T rqlite-1 rqlite");
    expect(r.log).toContain("compose cp rqlite-1:");
  });

  it("exits non-zero and removes the file when the archive is empty (cron-visible)", async () => {
    const r = await run({ archiveBytes: 0 });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("backup is empty");
    expect(existsSync(r.out)).toBe(false);
  });
});
