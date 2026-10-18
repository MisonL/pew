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
 *  - `compose exec` records the REPL transcript AND the environment the
 *    container would actually see (it echoes -e NAME values), so a regression
 *    that stops exporting the credential (dropping `set -a`) is caught even
 *    though argv still looks right.
 *  - `compose exec` on an unknown service fails, as compose does, so a
 *    wrong-service regression trips `set -e` — for the backup exec as well as
 *    cleanup and cp.
 *  - `compose cp` mimics docker's tar-mode semantics by chmod 644 on the
 *    destination: a plain host `cp` would inherit umask 077 and make the
 *    script's own `chmod 600` untestable.
 */
function run(opts: {
  archiveBytes?: number;
  archiveContents?: string;
  containerStale?: string;
  /** Simulate the real REPL's behavior on a failed .backup: prints ERR! to stdout, still exits 0, writes nothing. */
  replFails?: boolean;
  /** Simulate ENOSPC: the REPL writes a truncated archive that passes size and
   * magic gates, prints ERR! (stdout) and no success line, exits 0. */
  replTruncated?: boolean;
  /** Fail the pre-.backup rm (e.g. daemon error); set -e must abort the run. */
  rmFails?: boolean;
  /** Have cp land an empty host file despite a non-empty container file (defense-in-depth path). */
  cpProducesEmpty?: boolean;
  /** Sleep in the REPL / cp branch so a test can deliver a signal mid-run. */
  delayAt?: "repl" | "cp";
  delaySeconds?: number;
  /** Deliver this signal to the script after the given delay. */
  signal?: { name: NodeJS.Signals; afterMs: number };
  profile?: string;
  username?: string | null;
  password?: string | null;
  noEnvFile?: boolean;
  args?: string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), "bk-")); dirs.push(dir);
  // A world-traversable root makes the staging-directory assertion meaningful:
  // if the script staged in OUT_DIR itself, dirname would be 0755, not 0700.
  chmodSync(dir, 0o755);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // backup.sh cd's to its own directory (production layout: script next to
  // .env), so the script copy — not the real deploy/selfhost/.env — anchors
  // the run inside the temp dir.
  const script = join(dir, "backup.sh");
  copyFileSync(SCRIPT, script);

  const log = join(dir, "docker.log");
  const transcript = join(dir, "transcript");
  const containerEnv = join(dir, "container-env");
  const containerFile = join(dir, "container-backup.db");
  if (opts.containerStale !== undefined) {
    // Simulates an archive left in the container by an interrupted earlier
    // run (SIGKILL skips the cleanup trap).
    writeFileSync(containerFile, opts.containerStale);
  }
  const archive = join(dir, "archive.db");
  writeFileSync(
    archive,
    opts.archiveContents ?? (opts.archiveBytes === 0 ? "" : `SQLite format 3\0${"x".repeat(Math.max(0, (opts.archiveBytes ?? 64) - 16))}`)
  );

  const fakeDocker = `#!/bin/sh
# Log argv one per line so argument boundaries are observable.
{ printf 'ARGV\\n'; for a in "$@"; do printf '[%s]\\n' "$a"; done; } >> ${JSON.stringify(log)}
# Service existence: the cluster profile has no 'rqlite' service. Match the
# service ARGUMENT position for every call shape the script emits — plain
# exec, authenticated exec (-e flags before the service), cleanup, cp — but
# never the literal 'rqlite' inside the sh -c payload that runs the REPL.
case " $* " in
  *" exec -T rqlite "*|*" exec -T -e RQLITE_USERNAME -e RQLITE_PASSWORD rqlite "*|*" cp rqlite:"*)
    if [ "${opts.profile ?? "single"}" = "cluster" ]; then echo "no such service: rqlite" >&2; exit 1; fi;;
esac
case " $* " in
  *" exec "*" rm -f "*)
    # The pre-.backup rm must clear a stale archive (SIGKILL residue); track
    # the container file's existence so the later test -s gate sees it.
    # A wrong path here would leave the stale file in place, so the fake
    # refuses anything but the script's fixed container path.
    case " $* " in
      *" rm -f /rqlite/file/backup.db ") ;;
      *) echo "unexpected rm path: $*" >&2; exit 99;;
    esac
    if [ "${opts.rmFails ? "1" : "0"}" = "1" ]; then echo "Error response from daemon: rm failed" >&2; exit 1; fi
    rm -f ${JSON.stringify(containerFile)}
    exit 0;;
  *" exec "*" test -s "*)
    # The .backup success gate: succeeds only when the archive exists
    # non-empty — i.e. when some earlier .backup call actually produced it.
    # The path argument is asserted too: a wrong path here would silently
    # check the wrong file, so the fake refuses anything else.
    case " $* " in
      *" test -s /rqlite/file/backup.db ") ;;
      *) echo "unexpected test path: $*" >&2; exit 99;;
    esac
    if [ -s ${JSON.stringify(containerFile)} ]; then exit 0; fi
    echo "test -s: /rqlite/file/backup.db: No such file" >&2
    exit 1;;
  *" exec "*)
    # Capture the REPL transcript the script pipes in, and the environment the
    # container would receive: -e NAME forwards NAME's value from the caller.
    cat > ${JSON.stringify(transcript)}
    { printf 'RQLITE_USERNAME=%s\\n' "\${RQLITE_USERNAME-<UNSET>}"; printf 'RQLITE_PASSWORD=%s\\n' "\${RQLITE_PASSWORD-<UNSET>}"; } > ${JSON.stringify(containerEnv)}
    if [ "${opts.delayAt ?? ""}" = "repl" ]; then sleep ${opts.delaySeconds ?? 0}; fi
    # Faithful to the real REPL: a failed .backup prints ERR! to STDOUT (not
    # stderr — verified against 10.5.3) and STILL exits 0. It also writes
    # NOTHING to the container path — any file already there is left untouched,
    # which is exactly the stale-archive hazard the pre-rm guards against.
    # A success prints "backup file written successfully" (also stdout); the
    # script requires that line, so a truncated-on-ENOSPC archive cannot pass.
    if [ "${opts.replFails ? "1" : "0"}" = "1" ]; then
      printf 'ERR! unauthorized\\n'
    elif [ "${opts.replTruncated ? "1" : "0"}" = "1" ]; then
      # ENOSPC shape: a half-written file that still passes size + magic.
      head -c 64 ${JSON.stringify(archive)} > ${JSON.stringify(containerFile)}
      printf 'ERR! write /rqlite/file/backup.db: no space left on device\\n'
    else
      cp ${JSON.stringify(archive)} ${JSON.stringify(containerFile)}
      printf 'backup file written successfully\\n'
    fi
    exit 0;;
  *" cp "*)
    # The script must stage inside a 0700 directory: docker cp lands 0644
    # (tar mode), so between the cp and the script's chmod — and permanently
    # after a SIGKILL — the parent mode is the only protection.
    for last in "$@"; do :; done
    # Record the staging dir's mode AND its basename, plus the file's own mode
    # at cp time. The basename check is what catches a regression that stages
    # directly in OUT_DIR: the root here is 0755, so "700" can only come from
    # a fresh mktemp -d directory. GNU stat (-c %a) and BSD stat (-f %Lp)
    # disagree on flag spelling; the fake must run on both Linux CI and macOS.
    if stat -c '%a' "$(dirname "$last")" > ${JSON.stringify(join(dir, "stage-mode"))} 2>/dev/null; then
      :
    else
      stat -f '%Lp' "$(dirname "$last")" > ${JSON.stringify(join(dir, "stage-mode"))}
    fi
    printf '%s\\n' "$(basename "$(dirname "$last")")" > ${JSON.stringify(join(dir, "stage-name"))}
    if [ "${opts.delayAt ?? ""}" = "cp" ]; then sleep ${opts.delaySeconds ?? 0}; fi
    # docker cp copies the CONTAINER-side file: if a failed .backup left a
    # stale archive behind, that is what reaches the host; a missing file is
    # an error, exactly as real compose cp behaves.
    if [ ! -f ${JSON.stringify(containerFile)} ]; then
      echo "Error response from daemon: Could not find the file /rqlite/file/backup.db" >&2
      exit 1
    fi
    if [ "${opts.cpProducesEmpty ? "1" : "0"}" = "1" ]; then
      : > "$last"
    else
      cp ${JSON.stringify(containerFile)} "$last"
    fi
    # docker cp preserves the container-side mode (0644) and ignores umask.
    chmod 644 "$last"
    if stat -c '%a' "$last" > ${JSON.stringify(join(dir, "stage-file-mode"))} 2>/dev/null; then
      :
    else
      stat -f '%Lp' "$last" > ${JSON.stringify(join(dir, "stage-file-mode"))}
    fi
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
  if (opts.signal) {
    const { name, afterMs } = opts.signal;
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(name); }, afterMs).unref();
  }
  return new Promise<{
    code: number; signal: NodeJS.Signals | null; stderr: string; log: string;
    transcript: string; containerEnv: string; dir: string; out: string;
  }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({
      code: code ?? -1,
      signal,
      stderr,
      log: existsSync(log) ? readFileSync(log, "utf8") : "",
      transcript: existsSync(transcript) ? readFileSync(transcript, "utf8") : "",
      containerEnv: existsSync(containerEnv) ? readFileSync(containerEnv, "utf8") : "",
      dir,
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
    // The forwarded VALUES actually arrive in the container environment —
    // dropping `set -a` before sourcing .env leaves argv intact but forwards
    // unset variables (mutation-tested regression).
    expect(r.containerEnv).toContain("RQLITE_USERNAME=pew");
    expect(r.containerEnv).toContain(`RQLITE_PASSWORD=${"pw with spaces"}`);
    // The REPL transcript names the path the later cp reads.
    expect(r.transcript).toContain(".backup /rqlite/file/backup.db");
    expect(r.transcript).toContain(".exit");
    // cp copies exactly that path, into the 0700 staging dir beside OUT.
    expect(hasSequence(r.log, ["cp", "rqlite:/rqlite/file/backup.db"])).toBe(true);
    // The fake chmods the copy to 644 (docker's tar-mode behavior), so 0600
    // here can only come from the script's own chmod.
    expect(existsSync(r.out)).toBe(true);
    expect(statSync(r.out).mode & 0o777).toBe(0o600);
    // The staging dir that held the archive mid-run is gone on success.
    expect(readdirSync(dirname(r.out)).filter((n) => n.startsWith(".pew-backup."))).toEqual([]);
  });

  it("stages the archive in a fresh 0700 directory (SIGKILL-safety)", async () => {
    // The window between `docker compose cp` (lands 0644, tar mode) and the
    // script's chmod can only be closed by the parent directory when the run
    // is SIGKILLed — no trap fires then. The temp root is 0755, so a 700
    // parent can only come from the script's own mktemp -d, never from the
    // test fixture. The basename must be the .pew-backup.* staging dir, not
    // OUT_DIR itself (mutation: staging in OUT_DIR used to pass this test
    // because mkdtemp roots are already 0700).
    const r = await run({});
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(r.dir, "stage-mode"), "utf8").trim()).toBe("700");
    expect(readFileSync(join(r.dir, "stage-name"), "utf8").trim()).toMatch(/^\.pew-backup\.[A-Za-z0-9]{6}$/);
    // The file itself arrives 0644 from docker cp — protection comes from the
    // parent, which is exactly what the test above pins down.
    expect(readFileSync(join(r.dir, "stage-file-mode"), "utf8").trim()).toBe("644");
    // No staging dir survives a successful run.
    expect(readdirSync(dirname(r.out)).filter((n) => n.startsWith(".pew-backup."))).toEqual([]);
  });

  it("refuses a directory as the output path", async () => {
    // `mv TMP OUT` onto an existing directory silently relocates the archive
    // INTO it and still prints success (mutation-tested).
    const dir = mkdtempSync(join(tmpdir(), "bk-dirout-")); dirs.push(dir);
    const target = join(dir, "adir");
    mkdirSync(target);
    const r = await run({ args: [target] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is a directory");
  });

  it("targets rqlite-1 under the cluster profile and never touches the rqlite service", async () => {
    const r = await run({ profile: "cluster" });
    expect(r.code, r.stderr).toBe(0);
    // The fake fails on any `rqlite` service under the cluster profile, so a
    // wrong service would abort the run; assert it never appears at all.
    expect(hasSequence(r.log, ["cp", "rqlite:/rqlite/file/backup.db"])).toBe(false);
    expect(hasSequence(r.log, ["cp", "rqlite-1:/rqlite/file/backup.db"])).toBe(true);
    // The BACKUP exec (not just cleanup/cp) must use rqlite-1: a regression
    // that hardcodes the service in the exec line alone would otherwise pass.
    expect(hasSequence(r.log, [
      "exec", "-T", "-e", "RQLITE_USERNAME", "-e", "RQLITE_PASSWORD", "rqlite-1",
      "sh", "-c", 'exec rqlite -u "$RQLITE_USERNAME:$RQLITE_PASSWORD" -H localhost',
    ])).toBe(true);
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

  it("clears a stale in-container archive before .backup runs", async () => {
    // SIGKILL skips the cleanup trap, so a previous run can leave the
    // container path occupied. The script must rm it first with a checked
    // status — never best-effort — or a failed .backup would then copy and
    // validate that stale file and report success.
    const stale = `SQLite format 3\0${"stale".repeat(4)}`;
    const r = await run({ containerStale: stale });
    expect(r.code, r.stderr).toBe(0);
    // The rm must precede the .backup REPL call. .backup itself is REPL
    // stdin, not argv, so the second call is identified by its forwarded
    // credentials.
    const calls = r.log.split("\nARGV\n").filter(Boolean);
    const rmCall = calls.findIndex((c) => argLines(c).join(" ") === "[compose] [exec] [-T] [rqlite] [rm] [-f] [/rqlite/file/backup.db]");
    const backupCall = calls.findIndex((c) => c.includes("[RQLITE_PASSWORD]"));
    expect(rmCall).toBeGreaterThanOrEqual(0);
    expect(backupCall).toBeGreaterThan(rmCall);
    expect(r.transcript).toContain(".backup /rqlite/file/backup.db");
  });

  it("exits non-zero when .backup produced no archive (stale file present)", async () => {
    // Full real-world failure path: the container still holds a stale archive
    // from an interrupted run, the REPL fails (ERR! unauthorized, exit 0),
    // and the fake cp faithfully copies the stale container file. The script
    // must still fail: the pre-rm empties the container path and the test -s
    // gate stops the run before the stale bytes could reach the host.
    const stale = `SQLite format 3\0${"stale".repeat(4)}`;
    const r = await run({ containerStale: stale, replFails: true });
    expect(r.code).toBe(1);
    // The REPL success-line gate fires first now; the archive gates below it
    // remain as defense in depth.
    expect(r.stderr).toContain("did not report success");
    expect(existsSync(r.out)).toBe(false);
  });

  it("exits non-zero when the archive is empty (cron-visible)", async () => {
    const r = await run({ archiveBytes: 0 });
    expect(r.code).toBe(1);
    // The .backup gate fires before the copy: the empty archive never reaches
    // the host staging file.
    expect(r.stderr).toContain("no archive");
    expect(existsSync(r.out)).toBe(false);
  });

  it("aborts when the pre-.backup rm fails (set -e, cron-visible)", async () => {
    // The rm has no `|| true`: a daemon error there must abort before any
    // .backup/cp runs, otherwise the run could proceed against a stale file.
    const r = await run({ rmFails: true });
    expect(r.code).toBe(1);
    expect(r.transcript).toBe("");
    expect(existsSync(r.out)).toBe(false);
  });

  it("rejects an empty host copy even when the container file passed the gate", async () => {
    // Defense-in-depth branch: the container-side test -s passed, but the copy
    // itself lands zero bytes (e.g. a truncated transfer). The host-side
    // non-empty check is the last line before the atomic mv.
    const r = await run({ cpProducesEmpty: true });
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
    // No staging directory survives next to it either.
    expect(readdirSync(dir).filter((n) => n.startsWith(".pew-backup."))).toEqual([]);
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

  it("rejects a truncated archive that passes the size and magic gates (ENOSPC)", async () => {
    // Verified against rqlite 10.5.3: on a full filesystem .backup prints
    // `ERR! write ... no space left on device` to STDOUT, exits 0, and leaves
    // a truncated file that passes `test -s` and the SQLite magic check. Only
    // the missing success line distinguishes it — without this gate the run
    // replaces an intact earlier archive with a malformed one and exits 0.
    const dir = mkdtempSync(join(tmpdir(), "bk-enospc-")); dirs.push(dir);
    chmodSync(dir, 0o755);
    const existing = join(dir, "backup.db");
    writeFileSync(existing, "SQLite format 3\0previous-intact");
    const r = await run({ replTruncated: true, args: [existing] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("did not report success");
    // The intact earlier archive is untouched and no staging dir survives.
    expect(readFileSync(existing, "utf8")).toBe("SQLite format 3\0previous-intact");
    expect(readdirSync(dir).filter((n) => n.startsWith(".pew-backup."))).toEqual([]);
  });

  it("rejects an output path with . or .. components", async () => {
    // With a missing intermediate directory (`nodir/..`), `[ -d ]` is false,
    // mkdir -p creates it, and mv resolves to the PARENT — silently writing
    // elsewhere and possibly replacing an unrelated file (verified on macOS
    // and debian:12-slim).
    const dir = mkdtempSync(join(tmpdir(), "bk-dotdot-")); dirs.push(dir);
    chmodSync(dir, 0o755);
    // Build the paths by hand: node's join() normalizes "nodir/.." to the
    // parent, which would hide the very shape under test.
    for (const bad of [`${dir}/nodir/..`, `${dir}/nodir/.`]) {
      const r = await run({ args: [bad] });
      expect(r.code, `path ${bad}`).toBe(1);
      expect(r.stderr).toContain("refusing relative or self-referential");
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cleans the staging dir and exits 130 on SIGINT during the REPL", async () => {
    // SIGKILL is uncatchable, but INT/TERM/HUP must converge on the EXIT trap:
    // the staging directory (which may already hold a 0644 copy) and the
    // in-container archive both have to be removed. bash defers the trap
    // until the foreground `compose exec` child exits, hence the wait.
    const r = await run({ delayAt: "repl", delaySeconds: 1, signal: { name: "SIGINT", afterMs: 300 } });
    expect(r.code, r.stderr).toBe(130);
    expect(readdirSync(r.dir).filter((n) => n.startsWith(".pew-backup."))).toEqual([]);
    expect(r.log).toContain("[rm]");
  }, 30_000);

  it("cleans the staging dir and exits 143 on SIGTERM during the copy", async () => {
    // TERM during `compose cp`: the trap runs after the child finishes (a
    // shell cannot interrupt a running child), so the wait is deliberate.
    const r = await run({ delayAt: "cp", delaySeconds: 1, signal: { name: "SIGTERM", afterMs: 300 } });
    expect(r.code, r.stderr).toBe(143);
    expect(readdirSync(r.dir).filter((n) => n.startsWith(".pew-backup."))).toEqual([]);
    expect(existsSync(r.out)).toBe(false);
  }, 30_000);

  it("rejects an output path starting with '-' (GNU option parsing)", async () => {
    // On GNU userland `dirname --help`/`mv --help` treat the path as an
    // option: the run printed help, exited 0 and discarded the archive
    // (verified on debian:12-slim). BSD userland fails instead, so only a
    // Linux CI would have seen the silent success.
    const r = await run({ args: ["--help"] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("may not start with");
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
    // Two rm calls: the pre-.backup clear and the EXIT-trap cleanup. A single
    // occurrence would be satisfied by the pre-rm alone (mutation-verified:
    // removing the cleanup rm from the trap passed a count-1 assertion).
    const rmCalls = r.log.split("\nARGV\n").filter((c) => argLines(c).join(" ") === "[compose] [exec] [-T] [rqlite] [rm] [-f] [/rqlite/file/backup.db]");
    expect(rmCalls.length).toBe(2);
  });
});

/**
 * The fake logs one argument per line as `[arg]`, so a call can be matched by
 * its exact argv sequence. The log starts each docker invocation with a bare
 * `ARGV` line; `hasSequence` splits on it so a pattern can never match across
 * two invocations (F7: adjacency inside one call is what's asserted).
 */
function argLines(log: string): string[] {
  return log.split("\n").filter((line) => line.startsWith("["));
}

/** True when `seq` appears as a contiguous run of args within ONE docker call. */
function hasSequence(log: string, seq: string[]): boolean {
  const want = seq.map((a) => `[${a}]`);
  // Split on the bare `ARGV` marker: each chunk is one invocation's argv.
  return log.split("\nARGV\n").some((chunk) => {
    const lines = argLines(chunk);
    return lines.some((_, i) => want.every((w, j) => lines[i + j] === w));
  });
}
