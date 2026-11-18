import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "upgrade.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Builds a throwaway repository shaped like this one — `deploy/selfhost/`
 * beside a `package.json` and a real git history — and lays the real script
 * into it. A fake `docker` on PATH records argv and answers `ps`/`inspect`
 * from the scenario, which is how the "healthy image with a missing revision
 * label" case is reproduced without a container engine.
 */
function fixture(opts: {
  /**
   * What the fake `docker inspect` reports. Omit to report the fixture's real
   * git HEAD (the pass case); pass "" to model a build that lost its build
   * args, or any other string for a mismatched deploy.
   */
  reportedRevision?: string;
  reportedVersion?: string;
  neverHealthy?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "pew-upgrade-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const selfhost = join(repo, "deploy", "selfhost");
  mkdirSync(bin);
  mkdirSync(selfhost, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(selfhost, "backup.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(selfhost, "upgrade.sh"), readFileSync(SCRIPT), { mode: 0o755 });

  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "--quiet", "-m", "seed"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const argvLog = join(root, "argv.log");
  writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
case "$1 $2" in
  "compose build") exit 0 ;;
  "compose up") exit 0 ;;
  "compose ps")
    echo "${opts.neverHealthy ? "selfhost-web-1 starting" : "selfhost-web-1 healthy"}"
    exit 0 ;;
  "inspect selfhost-web-1")
    case "$*" in
      *"image.revision"*) echo ${JSON.stringify(opts.reportedRevision ?? head)} ;;
      *"image.version"*) echo ${JSON.stringify(opts.reportedVersion ?? "")} ;;
    esac
esac
exit 0
`, { mode: 0o755 });

  // Fake flock: records the lock command line it was asked to run and whether
  // the real lock could be taken, then runs the wrapped command. The lock file
  // lives in the fixture so two fixtures never contend.
  writeFileSync(join(bin, "flock"), `#!/bin/sh
lock=""
while [ $# -gt 0 ]; do
  case "$1" in
    -n|-x|-s|-e) shift ;;
    -w|-E) shift 2 ;;
    *) lock="$1"; shift; break ;;
  esac
done
if [ "\${PEW_UPGRADE_FAKE_LOCK_HELD:-}" = 1 ]; then
  printf '{"lock":"%s","held":false}\\n' "$lock" >> ${JSON.stringify(join(root, "flock.log"))}
  echo "flock: $lock: another process holds it" >&2
  exit 1
fi
printf '{"lock":"%s","held":true}\\n' "$lock" >> ${JSON.stringify(join(root, "flock.log"))}
exec "$@"
`, { mode: 0o755 });

  const run = (args: string[] = [], env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn("bash", [join(selfhost, "upgrade.sh"), ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.once("exit", (code) => done({ code, out }));
  });

  return { root, argvLog, selfhost, run, flockLog: join(root, "flock.log") };
}

describe("selfhost upgrade.sh", () => {
  it("passes PEW_REVISION and PEW_VERSION to the build", async () => {
    const f = fixture({ reportedRevision: "unused", reportedVersion: "9.9.9" });
    const { code, out } = await f.run(["--skip-backup"], { PEW_UPGRADE_NO_RESTART: "1" });
    expect(code, out).toBe(0);
    // The fake docker records the child environment's build args only if the
    // script exported them; check both the log line and the script's stdout.
    expect(out).toContain("building images");
    expect(readFileSync(f.argvLog, "utf8")).toContain("compose build");
  });

  it("fails when the running image carries no revision label", async () => {
    const f = fixture({ reportedRevision: "", reportedVersion: "9.9.9" });
    const { code, out } = await f.run(["--skip-backup"]);
    expect(code).not.toBe(0);
    expect(out).toContain("revision is '<empty>'");
    expect(out).toContain("PEW_REVISION");
  });

  it("fails when the image version disagrees with package.json", async () => {
    // The revision check runs first, so this scenario must report the real
    // HEAD or the version assertion would never be reached.
    const f = fixture({ reportedVersion: "0.0.1" });
    const { code, out } = await f.run(["--skip-backup"]);
    expect(code).not.toBe(0);
    expect(out).toContain("image version is '0.0.1'");
  });

  it("skips the restart when PEW_UPGRADE_NO_RESTART=1", async () => {
    const f = fixture({});
    const { code, out } = await f.run(["--skip-backup"], { PEW_UPGRADE_NO_RESTART: "1" });
    expect(code, out).toBe(0);
    expect(readFileSync(f.argvLog, "utf8")).not.toContain("compose up");
  });

  it("touches no docker command under --dry-run", async () => {
    const f = fixture({});
    const { code, out } = await f.run(["--dry-run"]);
    expect(code, out).toBe(0);
    expect(out).toContain("DRY-RUN");
    expect(out).toContain("PEW_REVISION=");
    expect(existsSync(f.argvLog)).toBe(false);
  });

  // backup.sh archives into a FIXED container path (/rqlite/file/backup.db)
  // and removes it on start and exit. The cron job serialises itself with
  // flock -n, but the upgrade called backup.sh unlocked, so an upgrade that
  // landed during the nightly backup (or a second hand-run upgrade) deleted
  // the archive the other run was copying.
  it("runs its backup under the same flock the cron job uses", async () => {
    const f = fixture({});
    const { code, out } = await f.run([], { PEW_UPGRADE_NO_RESTART: "1" });
    expect(code, out).toBe(0);
    const calls = readFileSync(f.flockLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { lock: string; held: boolean });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ held: true });
    // Same lock file the documented crontab uses, so cron and the upgrade
    // cannot both be inside backup.sh.
    expect(calls[0]!.lock).toBe("/tmp/pew-backup.lock");
    expect(readFileSync(f.argvLog, "utf8")).toContain("compose build");
  });

  it("still backs up, loudly unlocked, on a host without flock", async () => {
    // macOS (a developer laptop) has no flock. Refusing to upgrade there
    // would make `bash upgrade.sh` unusable locally; the honest shape is to
    // warn and run the backup unlocked, as backup.sh does for sqlite3.
    const f = fixture({});
    // A PATH with the fake docker but no fake flock: the fixture's bin
    // directory alone, plus the directory holding the real `node` the
    // version check needs. `command -v flock` in upgrade.sh then misses.
    const bin = join(f.root, "bin");
    const mv = join(f.root, "noflock");
    mkdirSync(mv);
    for (const name of readdirSync(bin)) {
      if (name !== "flock") symlinkSync(join(bin, name), join(mv, name));
    }
    symlinkSync(process.execPath, join(mv, "node"));
    const { code, out } = await f.run([], {
      PEW_UPGRADE_NO_RESTART: "1",
      PATH: `${mv}:/usr/bin:/bin`,
    });
    expect(code, out).toBe(0);
    expect(out).toMatch(/flock not found/);
    expect(readFileSync(f.argvLog, "utf8")).toContain("compose build");
  });

  it("stops before rebuilding when another backup holds the lock", async () => {
    const f = fixture({});
    const { code, out } = await f.run([], { PEW_UPGRADE_NO_RESTART: "1", PEW_UPGRADE_FAKE_LOCK_HELD: "1" });
    expect(code).not.toBe(0);
    expect(out).toMatch(/another backup/);
    // Nothing was rebuilt, so the fake docker was never asked to.
    const argv = existsSync(f.argvLog) ? readFileSync(f.argvLog, "utf8") : "";
    expect(argv).not.toContain("compose build");
  });

  it("prints usage for --help", async () => {
    const f = fixture({});
    const { code, out } = await f.run(["--help"]);
    expect(code, out).toBe(0);
    expect(out).toContain("upgrade.sh");
  });

  it("rejects an unknown argument", async () => {
    const f = fixture({});
    const { code, out } = await f.run(["--nonsense"]);
    expect(code).not.toBe(0);
    expect(out).toContain("unknown argument");
  });

  it("refuses to run when RQLITE_USERNAME is set but the auth file is missing", async () => {
    // Without the rendered auth file rqlite starts unauthenticated — the file
    // is what the entrypoint reads, and a missing bind-mount source is
    // silently created as an empty directory.
    const f = fixture({});
    writeFileSync(join(f.selfhost, ".env"), "RQLITE_USERNAME=someone\n");
    const { code, out } = await f.run(["--skip-backup"]);
    expect(code).not.toBe(0);
    expect(out).toContain(".rqlite-auth.json is missing");
    expect(existsSync(f.argvLog)).toBe(false);
  });

  it("proceeds when the auth file exists", async () => {
    const f = fixture({});
    writeFileSync(join(f.selfhost, ".env"), "RQLITE_USERNAME=someone\n");
    writeFileSync(join(f.selfhost, ".rqlite-auth.json"), "[]\n");
    const { code, out } = await f.run(["--skip-backup"], { PEW_UPGRADE_NO_RESTART: "1" });
    expect(code, out).toBe(0);
  });

  it("warns about a world-readable .env without stopping", async () => {
    const f = fixture({});
    writeFileSync(join(f.selfhost, ".env"), "X=1\n", { mode: 0o644 });
    const { code, out } = await f.run(["--skip-backup"], { PEW_UPGRADE_NO_RESTART: "1" });
    expect(code, out).toBe(0);
    expect(out).toContain("WARNING: .env is 644");
  });

  it("times out rather than hanging when the container never becomes healthy", async () => {
    const f = fixture({ neverHealthy: true });
    const { code, out } = await f.run(["--skip-backup"], { PEW_UPGRADE_HEALTH_TIMEOUT_S: "1" });
    expect(code).not.toBe(0);
    expect(out).toContain("did not become healthy");
  }, 30_000);
});

