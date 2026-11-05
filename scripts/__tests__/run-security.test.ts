import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Run the gate against stub tools so the cache behaviour can be observed
 * without hitting the network or requiring osv-scanner/gitleaks locally.
 */
function runGate(opts: { forceFresh: boolean }): {
  status: number | null;
  cache: Record<string, unknown>;
} {
  const binDir = mkdtempSync(join(tmpdir(), "pew-g2-bin-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "pew-g2-cache-"));
  const cacheFile = join(cacheDir, "g2-cache.json");

  const stub = (name: string, body: string) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  stub("osv-scanner", '[ "$1" = "--version" ] && { echo "osv-scanner 9.9.9"; exit 0; }\necho "No issues found"\nexit 0');
  stub("gitleaks", "exit 0");

  try {
    const sentinel = { osvLockHash: "stale", osvCheckedAt: 111 };
    writeFileSync(cacheFile, JSON.stringify(sentinel));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PEW_G2_CACHE_FILE: cacheFile,
    };
    const result = spawnSync("bun", ["scripts/run-security.ts"], {
      cwd: repoRoot,
      env: opts.forceFresh ? { ...env, PEW_G2_NO_CACHE: "1" } : env,
      encoding: "utf-8",
    });

    return {
      status: result.status,
      cache: JSON.parse(readFileSync(cacheFile, "utf-8")) as Record<string, unknown>,
    };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

describe("G2 security gate cache", () => {
  it("does not refresh the cache when the scan is forced fresh", () => {
    // PEW_G2_NO_CACHE=1 means "do not trust the cache". Writing a new
    // timestamp right after would silently re-arm it, so the next run would
    // skip the network scan the operator just paid for.
    const { status, cache } = runGate({ forceFresh: true });
    expect(status).toBe(0);
    expect(cache.osvCheckedAt).toBe(111);
    expect(cache.osvLockHash).toBe("stale");
  });

  it("refreshes the cache after a clean unforced scan", () => {
    const { status, cache } = runGate({ forceFresh: false });
    expect(status).toBe(0);
    expect(cache.osvCheckedAt).not.toBe(111);
    expect(cache.osvLockHash).not.toBe("stale");
  });
});
