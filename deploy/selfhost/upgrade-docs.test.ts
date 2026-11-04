import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// vitest runs ESM in Node, so import.meta.dir (Bun-only) is undefined; same
// pattern as deterministic-revision.test.ts and selfhost-infrastructure.test.ts.
const deployDir = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(deployDir, "README.md"), "utf8");

/** The first ```bash block after a heading, whose commands run from this dir. */
function sectionBlock(heading: string): string {
  const start = readme.indexOf(heading);
  if (start === -1) throw new Error(`missing heading: ${heading}`);
  const fence = readme.indexOf("```bash", start);
  if (fence === -1) throw new Error(`missing bash block: ${heading}`);
  const end = readme.indexOf("```", fence + 7);
  return readme.slice(fence + 7, end);
}

describe("selfhost upgrade instructions", () => {
  // Verified live on 2026-11-04: `docker compose build` without these env vars
  // produced images whose OCI revision/version labels were empty — the image
  // digest could not be traced back to a commit.
  it("passes the provenance build args in the upgrade block", () => {
    const block = sectionBlock("## 升级");
    expect(block).toMatch(/PEW_REVISION=\$\(git rev-parse HEAD\)/);
    expect(block).toMatch(/PEW_VERSION=\$\(node -p/);
    expect(block).toMatch(/docker compose build/);
  });

  it("keeps every documented package.json lookup resolvable from deploy/selfhost", () => {
    // The blocks run after `cd deploy/selfhost`; a path that does not resolve
    // aborts under node's module loader before compose ever starts.
    const lookups = [...readme.matchAll(/require\('([^']+package\.json)'\)/g)];
    expect(lookups.length).toBeGreaterThan(0);
    for (const [, rel] of lookups) {
      expect(existsSync(join(deployDir, rel)), `${rel} does not resolve from deploy/selfhost`).toBe(
        true,
      );
    }
  });
});
