import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The script spawns helpers by name, so the launches below must use the real
// interpreter resolved before the fixture rewrites the child's PATH.
const BUN = execSync("command -v bun", { shell: "/bin/sh", encoding: "utf8" }).trim();

interface Fixture {
  repo: string;
  path: string;
}

/**
 * Build a throwaway repository whose outside world is stubbed.
 *
 * `release.ts` resolves its project root from `import.meta.dirname`, so a copy
 * under `<tmp>/repo/scripts/` operates on the temp tree. git, bun and rg are
 * shell stubs on the child's PATH; `ghScript` is the stub's body so each case
 * can choose the release outcome. Nothing here reaches the real repository,
 * the network or a tag.
 */
function fixture(ghScript: string | null, rgBody = "exit 1"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pew-release-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub("git", `case "$1" in
  status) exit 0;;
  symbolic-ref) echo "main"; exit 0;;
  describe) echo "v0.0.1"; exit 0;;
  log) echo "abc123|||fix: something"; exit 0;;
  *) exit 0;;
esac`);
  stub("bun", "exit 0");
  stub("rg", rgBody);
  // null leaves gh off the PATH entirely.
  if (ghScript !== null) stub("gh", ghScript);

  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(
    join(repo, "scripts", "release.ts"),
    readFileSync(new URL("../../scripts/release.ts", import.meta.url), "utf8"),
  );
  for (const path of [
    "package.json",
    "packages/core/package.json",
    "packages/cli/package.json",
    "packages/web/package.json",
    "packages/worker/package.json",
    "packages/worker-read/package.json",
  ]) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    // Two-space JSON, like the real manifests: the bump matches the literal
    // `"version": "1.2.3"` text.
    writeFileSync(join(repo, path), JSON.stringify({ name: path, version: "1.2.3", private: true }, null, 2));
  }
  for (const path of ["packages/worker/src/index.ts", "packages/worker-read/src/index.ts"]) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), 'export const VERSION = "1.2.3";\n');
  }
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(repo, "bun.lock"), "");
  return { repo, path: bin };
}

function runRelease(
  ghScript: string | null,
  args: string[] = ["1.2.4"],
  rgBody = "exit 1",
): { code: number; output: string } {
  const { repo, path } = fixture(ghScript, rgBody);
  // The fixture's gh stub sits first on PATH, but the inherited PATH can also
  // contain a real gh (Homebrew's /usr/local/bin). Strip every PATH entry
  // holding a gh binary so "not installed" is actually what the child sees.
  const withoutGh = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => !existsSync(join(dir, "gh")))
    .join(":");
  const result = spawnSync(BUN, ["run", join(repo, "scripts", "release.ts"), "--", ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path}:${ghScript === null ? withoutGh : process.env.PATH ?? ""}` },
    timeout: 90_000,
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

const GH_OK = `case "$1 $2" in
  "auth status") exit 0;;
  "release create") echo "https://example.invalid/nocoo/pew/releases/tag/vX"; exit 0;;
  "repo view") echo "https://example.invalid/nocoo/pew";;
  *) exit 1;;
esac`;

describe("release.ts", () => {
  it("validates every version target before writing any of them", () => {
    // Phase 1 rewrote VERSION_TARGETS one by one and only then counted
    // failures, so a drifted target (a const-version that moved, a reformatted
    // manifest) left half the tree bumped and the operator was told to run
    // `git checkout .`. Validate first; write only once everything is located.
    const { repo, path } = fixture(GH_OK);
    writeFileSync(join(repo, "packages/worker/src/index.ts"), 'export const VERSION = "9.9.9";\n');
    const result = spawnSync(BUN, ["run", join(repo, "scripts", "release.ts"), "--", "1.2.4"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path}:${process.env.PATH}` },
      timeout: 90_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("version targets are not in the expected shape");
    expect(output).toContain("packages/worker/src/index.ts");
    expect(readFileSync(join(repo, "package.json"), "utf8")).toContain('"version": "1.2.3"');
  });

  it("exits non-zero when gh release create fails after the tag is pushed", () => {
    // The tag is already pushed at that point, so the run cannot be repeated;
    // but a release that ended without its GitHub entry must not report
    // success to whatever invoked it.
    const result = runRelease(`case "$1 $2" in
  "auth status") exit 0;;
  "release create") echo "HTTP 401: Bad credentials" >&2; exit 1;;
  "repo view") echo "https://example.invalid/nocoo/pew";;
  *) exit 1;;
esac`);
    expect(result.output).toContain("GitHub release creation failed");
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("✅ Released");
  });

  it("completes successfully when every step succeeds", () => {
    const result = runRelease(GH_OK);
    expect(result.output).toContain("✅ Released v1.2.4");
    expect(result.code).toBe(0);
  });

  it("skips the GitHub release when gh is not installed", () => {
    // spawn() reports a missing binary through the child's 'error' event, and
    // run() only listened for 'close'. An unhandled 'error' crashes the
    // process, so the "gh absent -> skip the release" branch was unreachable:
    // the operator got an uncaught ENOENT stack instead of a finished release.
    const result = runRelease(null);
    expect(result.output).toContain("will skip GitHub release");
    expect(result.code).toBe(0);
    expect(result.output).toContain("✅ Released v1.2.4");
  });

  it("refuses to claim a clean stale-version check when rg cannot run", () => {
    // The gate treated every non-zero rg exit as "no matches". rg is not a
    // declared dependency, so a checkout without it passed the check without
    // scanning anything — the one failure mode a version check must not have.
    const result = runRelease(GH_OK, ["1.2.4"], 'echo "rg: command failure" >&2; exit 2');
    expect(result.code).toBe(1);
    expect(result.output).toContain("could not verify");
    expect(result.output).not.toContain("✅ Released");
  });
});
