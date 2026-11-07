import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir as realReaddir, stat as realStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "../source-walk";

function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "pew-walk-"));
  mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "root.ts"), "export {};\n");
  writeFileSync(join(root, "packages", "core", "src", "a.ts"), "export {};\n");
  writeFileSync(join(root, "packages", "core", "src", "b.tsx"), "export {};\n");
  writeFileSync(join(root, "packages", "core", "README.md"), "#\n");
  writeFileSync(join(root, "node_modules", "dep", "c.ts"), "export {};\n");
  return root;
}

async function collect(root: string, opts?: Parameters<typeof walkSourceFiles>[1]): Promise<string[]> {
  const seen: string[] = [];
  for await (const file of walkSourceFiles(root, opts ?? { match: /\.ts$/ })) {
    seen.push(relative(root, file));
  }
  return seen.sort();
}

describe("walkSourceFiles", () => {
  it("yields matching files and does not descend into pruned directories", async () => {
    const root = tempTree();
    try {
      expect(await collect(root)).toEqual(["packages/core/src/a.ts", "root.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing root as an empty scan", async () => {
    // The gates fail on a zero-file scan, so an absent root must stay an empty
    // result rather than an error — otherwise every non-checkout caller dies.
    const root = mkdtempSync(join(tmpdir(), "pew-walk-"));
    rmSync(root, { recursive: true, force: true });
    await expect(collect(root)).resolves.toEqual([]);
  });

  it("aborts the scan when a directory cannot be listed", async () => {
    // A readdir that fails for anything but "the directory is gone" must not
    // shrink the scan silently: the gate would print ✓ while an entire subtree
    // went unchecked, which is indistinguishable from a clean tree.
    const root = tempTree();
    try {
      const deps = {
        readdir: async (dir: string) => {
          if (dir.endsWith(join("core", "src"))) {
            throw Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), {
              code: "EACCES",
            });
          }
          return realReaddir(dir);
        },
      };
      await expect(collect(root, { match: /\.ts$/, deps })).rejects.toThrow(/EACCES/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts the scan when an entry cannot be inspected", async () => {
    // Same reasoning one level down: a stat failure means the gate cannot say
    // whether the path was a source file.
    const root = tempTree();
    try {
      const deps = {
        stat: async (path: string) => {
          if (path.endsWith("a.ts")) {
            throw Object.assign(new Error(`EIO: i/o error, stat '${path}'`), { code: "EIO" });
          }
          return realStat(path);
        },
      };
      await expect(collect(root, { match: /\.ts$/, deps })).rejects.toThrow(/EIO/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips a dangling symlink instead of yielding an unreadable path", async () => {
    // A broken link is a real entry that cannot be scanned; the walker must not
    // hand its path to readFileSync (ENOENT) nor abort the whole gate on it.
    const root = mktempWithLink();
    try {
      expect(await collect(root)).toEqual(["root.ts"]);
      expect(readdirSync(root)).toContain("gone.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function mktempWithLink(): string {
  const root = mkdtempSync(join(tmpdir(), "pew-walk-"));
  writeFileSync(join(root, "root.ts"), "export {};\n");
  symlinkSync(join(root, "does-not-exist.ts"), join(root, "gone.ts"));
  return root;
}
