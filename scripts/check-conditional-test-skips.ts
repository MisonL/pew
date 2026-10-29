#!/usr/bin/env bun
/**
 * Static guard against conditionally-disabled tests.
 *
 * Rationale: `it.skipIf(cond)` / `it.runIf(cond)` disable a test for some
 * environments and not others. When the condition is `process.env.CI`, the
 * test runs locally and vanishes in CI — or the reverse — so the two gates
 * measure different code. A real instance: three inode-change tests were
 * skipped under CI, which left `sync.ts`'s inode-replay branch uncovered
 * there, and CI failed the 95% branch floor at 94.9988% on a commit that
 * passed locally at 95.0200%. Nothing in the gate reported the skip.
 *
 * biome 2.5's `noSkippedTests` / `noFocusedTests` catch `.skip` and `.only`
 * but not the conditional forms — verified by probe, they pass clean. This
 * script closes that gap so the same divergence cannot come back unnoticed.
 *
 * Fix the underlying environment dependence instead of skipping: replace the
 * filesystem/timing assumption the test rests on, as the inode tests now do
 * by renaming a replacement over the live file.
 *
 * Extend ALLOWED_SITES with justified sites (each entry requires a reason).
 * Keys are `${repoRelPath}:${1-indexed-line}` — per-line, NOT per-file, so
 * a new conditional skip in the same file still triggers.
 */

import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";

const REPO_ROOT = join(import.meta.dir, "..");

// Whole-repo scan; pre-commit runs this gate with cwd set to a temp
// snapshot of the Git index (see .husky/pre-commit), so `import.meta.dir/..`
// is that snapshot.
const ROOTS = [REPO_ROOT];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".next-e2e",
  ".next-e2e-ui",
  ".next-e2e-unit",
  "coverage",
  "__golden__",
  ".git",
  ".husky",
  ".claude",
  ".wrangler",
]);

// The test-defining roots whose conditional modifiers we care about.
const TEST_ROOTS = new Set(["it", "test", "describe", "suite", "context"]);
// Modifiers that make a test's execution depend on the environment.
const CONDITIONAL_MODIFIERS = new Set(["skipIf", "runIf"]);

const ALLOWED_SITES: Record<string, string> = {};

interface Violation {
  path: string;
  line: number;
  col: number;
  snippet: string;
}

interface Loc {
  line: number;
  column: number;
}

interface OxcNode {
  type: string;
  start?: number;
  end?: number;
  loc?: { start: Loc; end: Loc };
  name?: string;
  object?: OxcNode;
  property?: OxcNode;
  computed?: boolean;
  callee?: OxcNode;
  [key: string]: unknown;
}

/** True when `node` is a member chain rooted at a test-defining identifier. */
function isTestRootedChain(node: OxcNode | undefined): boolean {
  let cur = node;
  while (cur) {
    if (
      cur.type === "ParenthesizedExpression" ||
      cur.type === "TSNonNullExpression" ||
      cur.type === "ChainExpression"
    ) {
      cur = (cur as { expression?: OxcNode }).expression;
      continue;
    }
    if (cur.type === "Identifier") return TEST_ROOTS.has(cur.name ?? "");
    if (cur.type === "MemberExpression") {
      cur = cur.object;
      continue;
    }
    // `it.each([...]).skipIf(...)` — the modifier's object is the `it.each`
    // call; descend through it so the each-form is not a blind spot.
    if (cur.type === "CallExpression") {
      cur = cur.callee;
      continue;
    }
    return false;
  }
  return false;
}

/** Returns the flagged modifier name when `node` is `it.skipIf`-shaped. */
function conditionalModifier(node: OxcNode | undefined): string | null {
  if (node?.type !== "MemberExpression" || node.computed) return null;
  const prop = node.property;
  if (prop?.type !== "Identifier") return null;
  const name = prop.name ?? "";
  if (!CONDITIONAL_MODIFIERS.has(name)) return null;
  if (!isTestRootedChain(node.object)) return null;
  return name;
}

// oxc-parser does not always attach `loc` to every node, so derive the
// position from the byte offset rather than trusting `node.loc`.
function posToLine(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function posToCol(src: string, pos: number): number {
  let col = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (src.charCodeAt(i) === 10) break;
    col++;
  }
  return col;
}

function collect(
  node: OxcNode | null | undefined,
  path: string,
  src: string,
  out: Violation[],
): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "CallExpression") {
    const modifier = conditionalModifier(node.callee);
    if (modifier) {
      const startPos = node.start ?? 0;
      const line = node.loc?.start.line ?? posToLine(src, startPos);
      const col = node.loc?.start.column ?? posToCol(src, startPos);
      const endPos = node.end ?? startPos;
      const site = `${path}:${line}`;
      if (!(site in ALLOWED_SITES)) {
        out.push({
          path,
          line,
          col: col + 1,
          snippet: (src.slice(startPos, endPos).split("\n")[0] ?? "").trim(),
        });
      }
    }
  }
  for (const key in node) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) collect(item as OxcNode, path, src, out);
    } else if (value && typeof value === "object" && "type" in (value as object)) {
      collect(value as OxcNode, path, src, out);
    }
  }
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  let scannedCount = 0;

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const s = await stat(full);
      if (s.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(full);
      } else if (/\.(tsx|ts|mts|cts)$/.test(name)) {
        scannedCount++;
        const src = readFileSync(full, "utf-8");
        const repoRel = relative(REPO_ROOT, full);
        const r = parseSync(full, src);
        if (r.errors.length > 0) {
          for (const err of r.errors) {
            console.error(`✗ parse error ${repoRel}: ${err.message}`);
          }
          process.exit(1);
        }
        collect(r.program as unknown as OxcNode, repoRel, src, violations);
      }
    }
  }

  for (const root of ROOTS) await walk(root);

  if (scannedCount === 0) {
    console.error(
      `FATAL: scanned 0 files under ${ROOTS.join(", ")} — misconfigured?`,
    );
    process.exit(1);
  }

  if (violations.length === 0) {
    console.log(
      `✓ no conditional test skip found (${scannedCount} files scanned, ${Object.keys(ALLOWED_SITES).length} whitelisted)`,
    );
    process.exit(0);
  }

  console.error(
    `✗ conditional test skip forbidden (${violations.length} site${violations.length === 1 ? "" : "s"}):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}:${v.col}`);
    console.error(`    ${v.snippet}`);
  }
  console.error(
    "\n  skipIf/runIf make local and CI measure different code. Remove the",
  );
  console.error(
    "  environment dependence (filesystem assumption, dead PID, timing) so",
  );
  console.error("  the test runs everywhere.");
  console.error(
    "  If truly necessary, add a `" + "$" + "{repoRelPath}:$" + "{line}` entry to ALLOWED_SITES with a reason.",
  );
  process.exit(1);
}

void main();
