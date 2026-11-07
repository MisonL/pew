import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Directories never scanned. These gates mirror the whole-repo scope of the
 * retired eslint strict run, minus build output, VCS/tooling state and test
 * golden fixtures.
 */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
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

export interface WalkDeps {
  readdir: typeof readdir;
  stat: typeof stat;
}

export interface WalkOptions {
  /** Entry-name pattern of the files the caller scans. */
  readonly match: RegExp;
  readonly skipDirs?: ReadonlySet<string>;
  readonly deps?: Partial<WalkDeps>;
}

/**
 * Depth-first walk yielding the matching files under `root`.
 *
 * Fail closed: a directory that cannot be listed, or an entry that cannot be
 * inspected, aborts the walk with that error. The gates that use this treat a
 * completed walk as a clean tree, so skipping an unreadable subtree would
 * report ✓ for code that was never examined. The two tolerated absences are
 * a missing directory (ENOENT — a partial checkout from the index snapshot,
 * and the caller's zero-file guard still catches a root that does not exist)
 * and a dangling symlink (ENOENT from stat — a real entry whose target is
 * gone, which cannot be scanned but must not hide its siblings).
 */
export async function* walkSourceFiles(
  root: string,
  opts: WalkOptions,
): AsyncGenerator<string, void, void> {
  const rd = opts.deps?.readdir ?? readdir;
  const st = opts.deps?.stat ?? stat;
  const skip = opts.skipDirs ?? DEFAULT_SKIP_DIRS;

  async function* walk(dir: string): AsyncGenerator<string, void, void> {
    let entries: string[];
    try {
      entries = await rd(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      throw err;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await st(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
        throw err;
      }
      if (info.isDirectory()) {
        if (skip.has(name)) continue;
        yield* walk(full);
      } else if (opts.match.test(name)) {
        yield full;
      }
    }
  }

  yield* walk(root);
}
