/**
 * Pi notification hook.
 *
 * Pi supports extensions via ~/.pi/agent/extensions/*.ts files.
 * We install a simple extension that fires `pew notify --source=pi`
 * on `session_shutdown` events.
 *
 * Unlike Claude/Gemini (which modify settings.json), pi hooks are
 * standalone TypeScript files — install = write file, uninstall = delete file.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NotifierOperationResult, NotifierStatus } from "@pew/core";

interface PiHookFs {
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile: (path: string, data: string, encoding: BufferEncoding) => Promise<unknown>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  unlink: (path: string) => Promise<unknown>;
}

export interface PiHookOptions {
  /** Path to the pew extension file, e.g. ~/.pi/agent/extensions/pew-sync.ts */
  extensionPath: string;
  /** Path to notify.cjs handler */
  notifyPath: string;
  fs?: PiHookFs;
}

const SOURCE = "pi";
const MARKER = "PEW_PI_HOOK";

function buildExtensionContent(notifyPath: string): string {
  return `// ${MARKER} — managed by pew, do not edit
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    try {
      const child = spawn("node", [${JSON.stringify(notifyPath)}, "--source=pi"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {}
  });
}
`;
}

export async function installPiHook(
  opts: PiHookOptions,
): Promise<NotifierOperationResult> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir, unlink };
  const content = buildExtensionContent(opts.notifyPath);

  // Check if already installed
  let existing: string | null = null;
  try {
    existing = await fs.readFile(opts.extensionPath, "utf8");
  } catch (err) {
    // Only a missing file means "nothing to preserve". An unreadable one
    // (EACCES, EISDIR, a symlink loop) must not be read as "write over it".
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw err;
  }

  // The path is pew's own, but a user may have put their extension there. This
  // file is "not managed by pew" for uninstall and status, so install must not
  // destroy it either — overwriting would remove exactly what the other two
  // refuse to touch.
  if (existing !== null && !existing.includes(MARKER)) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail:
        "ownership_conflict: the Pi extension file exists but is not managed by pew; refusing to replace it",
      warnings: [
        `Move or remove ${opts.extensionPath} and re-run \`pew init --source=pi\` to install the hook.`,
      ],
    };
  }

  if (existing?.includes(MARKER)) {
    // Already installed — check if content matches
    if (existing === content) {
      return {
        source: SOURCE,
        action: "install",
        changed: false,
        detail: "Pi hook already installed",
      };
    }
    // Update to latest version
  }

  await fs.mkdir(dirname(opts.extensionPath), { recursive: true });
  await fs.writeFile(opts.extensionPath, content, "utf8");

  return {
    source: SOURCE,
    action: "install",
    changed: true,
    detail: "Pi hook installed",
  };
}

export async function uninstallPiHook(
  opts: PiHookOptions,
): Promise<NotifierOperationResult> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir, unlink };

  let existing: string;
  try {
    existing = await fs.readFile(opts.extensionPath, "utf8");
  } catch {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Pi hook not found",
    };
  }

  if (!existing.includes(MARKER)) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Pi hook not managed by pew",
    };
  }

  try {
    await fs.unlink(opts.extensionPath);
  } catch (error) {
    // Claiming success here is not cosmetic: `pew uninstall` deletes the
    // shared notify.cjs only when every driver is warning-free, so a file
    // left on disk would keep spawning a handler that no longer exists.
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: `Pi hook could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      warnings: [
        `Remove ${opts.extensionPath} manually; until then it keeps invoking the shared notifier.`,
      ],
    };
  }

  return {
    source: SOURCE,
    action: "uninstall",
    changed: true,
    detail: "Pi hook removed",
  };
}

export async function getPiHookStatus(
  opts: PiHookOptions,
): Promise<NotifierStatus> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir, unlink };

  try {
    const content = await fs.readFile(opts.extensionPath, "utf8");
    if (content.includes(MARKER)) return "installed";
    return "not-installed";
  } catch {
    return "not-installed";
  }
}
