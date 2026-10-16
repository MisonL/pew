import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
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
 * Runs backup.sh against a fake `docker` on PATH.
 *
 * The fake is deliberately faithful to the behaviors that make the real
 * script's guarantees meaningful:
 *  - argv is logged ONE ARGUMENT PER LINE, so the absence of a credential in
 *    argv and the exact shape of a forwarded call are both assertable.
 *  - `compose cp` mimics docker's tar-mode semantics by chmod 644 on the
 *    destination: a plain host `cp` would inherit umask 077 and make the
 *    script's own `chmod 600` untestable.
 *  - `compose exec` records the REPL transcript the script pipes in.
 *  - an unknown service (rqlite under the cluster profile) fails, as compose
 *    does, so a wrong-service regression trips `set -e`.
 */
function run(opts: {
  archiveBytes?: number;
  archiveContents?: string;
  profile?: string;
  username?: string | null;
  password?: string | null;
  noEnvFile?: boolean;
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
  const transcript = join(dir, "transcript");
  const archive = join(dir, "archive.db");
  writeFileSync(
    archive,
    opts.archiveContents ?? (opts.archiveBytes === 0 ? "" : `SQLite format 3\0${"x".repeat(Math.max(0, (opts.archiveBytes ?? 64) - 16))}`)
  );

  const fakeDocker = `#!/bin/sh
# Log argv one per line so argument boundaries are observable.
{ printf 'ARGV\\n'; for a in "$@"; do printf '[%s]\\n' "$a"; done; } >> ${JSON.stringify(log)}
case " $* " in
  *" exec "*" rm -f "*)
    exit 0;;
  *" exec "*)
    # Capture the REPL transcript the script pipes in.
    cat > ${JSON.stringify(transcript)}
    exit 0;;
  *" cp "*)
    # Service existence: the cluster profile has no 'rqlite' service.
    case " $* " in
      *" cp rqlite:"*) [ "${opts.profile ?? "single"}" = "cluster" ] && { echo "no such service: rqlite" >&2; exit 1; };;
    esac
    # Destination is the last argument.
    for last in "$@"; do :; done
    cp ${JSON.stringify(archive)} "$last"
    # docker cp preserves the container-side mode (0644) and ignores umask.
    chmod 644 "$last"
    exit 0;;
esac
exit 0
`;
  writeFileSync(join(bin, "docker"), fakeDocker);
  chmodSync(join(bin, "docker"), 0o755);

  if (!opts.noEnvFile) {
    const lines = [`COMPOSE_PROFILES=${opts.profile ?? "single"}`];
    if (opts.username !== null) lines.push(`RQLITE_USERNAME=${opts.username ?? "pew"}`);
    if (opts.password !== null) lines.push(`RQLITE_PASSWORD='${opts.password ?? "pw with spaces"}'`);
    writeFileSync(join(dir, ".env"), `${lines.join("\n")}\n`);
  }

  const out = join(dir, "out.db");
  const child = spawn("bash", [script, ...(opts.args ?? [out])], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<{ code: number; stderr: string; log: string; transcript: string; out: string }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({
      code: code ?? -1,
      stderr,
      log: existsSync(log) ? readFileSync(log, "utf8") : "",
      transcript: existsSync(transcript) ? readFileSync(transcript, "utf8") : "",
      out,
    }));
  });
}

describe("backup.sh", () => {
  it("backs up via the single-node service and chmods the archive to 0600", async () => {
    const r = await run({});
    expect(r.code, r.stderr).toBe(0);
    // Credentials reach the container as env-var NAMES: -e VAR forwards the
    // value from this shell, so no argv entry carries the secret (argv is
    // world-readable in `ps`, the environment is not).
    expect(hasSequence(r.log, [
      "exec", "-T", "-e", "RQLITE_USERNAME", "-e", "RQLITE_PASSWORD", "rqlite",
      "sh", "-c", 'exec rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost',
    ])).toBe(true);
    expect(argLines(r.log).some((line) => line.includes("pw with spaces"))).toBe(false);
    // The REPL transcript names the path the later cp reads.
    expect(r.transcript).toContain(".backup /rqlite/file/backup.db");
    expect(r.transcript).toContain(".exit");
    // cp copies exactly that path, into a temp sibling of the destination.
    expect(hasSequence(r.log, ["cp", "rqlite:/rqlite/file/backup.db"])).toBe(true);
    expect(argLines(r.log).some((line) => line.startsWith(`[${r.out}.tmp.`))).toBe(true);
    // The fake chmods the copy to 644 (docker's tar-mode behavior), so 0600
    // here can only come from the script's own chmod.
    expect(existsSync(r.out)).toBe(true);
    expect(statSync(r.out).mode & 0o777).toBe(0o600);
  });

  it("targets rqlite-1 under the cluster profile and never touches the rqlite service", async () => {
    const r = await run({ profile: "cluster" });
    expect(r.code, r.stderr).toBe(0);
    // The fake fails on `cp rqlite:` under the cluster profile, so a wrong
    // service would abort the run; assert it never appears at all.
    expect(hasSequence(r.log, ["cp", "rqlite:/rqlite/file/backup.db"])).toBe(false);
    expect(hasSequence(r.log, ["cp", "rqlite-1:/rqlite/file/backup.db"])).toBe(true);
    expect(hasSequence(r.log, ["exec", "-T", "rqlite-1", "rm", "-f", "/rqlite/file/backup.db"])).toBe(true);
  });

  it("matches a comma-form COMPOSE_PROFILES list containing cluster", async () => {
    const r = await run({ profile: "single,cluster" });
    expect(r.code, r.stderr).toBe(0);
    expect(hasSequence(r.log, ["cp", "rqlite-1:/rqlite/file/backup.db"])).toBe(true);
  });

  it("omits the credential flags for a no-auth deployment (and survives bash 3.2)", async () => {
    // The README-documented default: no RQLITE_USERNAME. Under `set -u` a
    // naive empty-array expansion aborts on bash < 4.4; the script must work.
    const r = await run({ username: null, password: null });
    expect(r.code, r.stderr).toBe(0);
    expect(r.log).not.toContain("[RQLITE_USERNAME]");
    expect(hasSequence(r.log, ["exec", "-T", "rqlite", "rqlite", "-H", "localhost"])).toBe(true);
  });

  it("treats a half-filled credential pair as unset (no -u with an empty password)", async () => {
    const r = await run({ username: "pew", password: null });
    expect(r.code, r.stderr).toBe(0);
    expect(r.log).not.toContain("[RQLITE_USERNAME]");
    expect(hasSequence(r.log, ["exec", "-T", "rqlite", "rqlite", "-H", "localhost"])).toBe(true);
  });

  it("works without an .env file at all", async () => {
    const r = await run({ noEnvFile: true });
    expect(r.code, r.stderr).toBe(0);
    expect(hasSequence(r.log, ["exec", "-T", "rqlite", "rqlite", "-H", "localhost"])).toBe(true);
  });

  it("exits non-zero and keeps no file when the archive is empty (cron-visible)", async () => {
    const r = await run({ archiveBytes: 0 });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("backup is empty");
    expect(existsSync(r.out)).toBe(false);
  });

  it("rejects a non-empty but non-SQLite artifact", async () => {
    const r = await run({ archiveContents: "Unauthorized\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a SQLite database");
    expect(existsSync(r.out)).toBe(false);
  });

  it("leaves an existing archive intact when the new run fails", async () => {
    // Same-day re-run after a failed .backup must not clobber a good backup:
    // validation runs on the temp file, so the destination is only replaced
    // once the new archive has been proven good.
    const dir = mkdtempSync(join(tmpdir(), "bk-prev-")); dirs.push(dir);
    const existing = join(dir, "backup.db");
    writeFileSync(existing, "SQLite format 3\0previous");
    const again = await run({ archiveBytes: 0, args: [existing] });
    expect(again.code).toBe(1);
    expect(readFileSync(existing, "utf8")).toBe("SQLite format 3\0previous");
    // No stray temp files remain next to it.
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("creates the output directory when it does not exist", async () => {
    // A cron target (/var/backups/pew) usually does not exist yet, and
    // `docker compose cp` refuses a missing parent.
    const dir = mkdtempSync(join(tmpdir(), "bk-mk-")); dirs.push(dir);
    const nested = join(dir, "a", "b", "backup.db");
    const res = await run({ args: [nested] });
    expect(res.code, res.stderr).toBe(0);
    expect(existsSync(nested)).toBe(true);
  });

  it("defaults to a dated archive next to the script", async () => {
    // Compared as a shape, not against a computed date: `date +%F` is local
    // time, so an exact-name assertion would be wrong near midnight.
    const r = await run({ args: [] });
    expect(r.code, r.stderr).toBe(0);
    const dated = readdirSync(dirname(r.out)).filter((n) => /^backup-\d{4}-\d{2}-\d{2}\.db$/.test(n));
    expect(dated.length, `no dated archive in ${dirname(r.out)}`).toBe(1);
    expect(statSync(join(dirname(r.out), dated[0])).mode & 0o777).toBe(0o600);
  });

  it("cleans the in-container archive on a successful run", async () => {
    const r = await run({});
    expect(hasSequence(r.log, ["exec", "-T", "rqlite", "rm", "-f", "/rqlite/file/backup.db"])).toBe(true);
  });
});

/**
 * The fake logs one argument per line as `[arg]`, so a call can be matched by
 * its exact argv sequence.
 */
function argLines(log: string): string[] {
  return log.split("\n").filter((line) => line.startsWith("["));
}

/** True when `seq` appears as a contiguous run of logged arguments. */
function hasSequence(log: string, seq: string[]): boolean {
  const lines = argLines(log);
  const want = seq.map((a) => `[${a}]`);
  return lines.some((_, i) => want.every((w, j) => lines[i + j] === w));
}
