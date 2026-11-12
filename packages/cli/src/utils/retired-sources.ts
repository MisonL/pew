import type { Source } from "@pew/core";
import { readFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { QueueState } from "../storage/base-queue.js";

export const RETIRED_SOURCES: Source[] = ["gemini-cli", "kosmos", "omp", "zcode", "pmstudio", "vscode-copilot"];
export const isRetiredSource = (source: string): boolean => RETIRED_SOURCES.includes(source as Source);

export function isRetiredCursorPath(path: string, activePaths: ReadonlyArray<string | undefined> = []): boolean {
  if (activePaths.some((root) => {
    if (!root) return false;
    const child = relative(root, path);
    return !isAbsolute(child) && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\");
  })) return false;
  return /(?:^|[/\\])(?:\.gemini[/\\]tmp|\.omp|\.zcode|kosmos-app|pm-studio-app|Code(?: - Insiders)?[/\\]User)(?:[/\\]|$)/.test(path);
}

/**
 * Lenient queue-state read for self-healing paths.
 *
 * The strict reader above fails closed, which is right for a retained backlog
 * a reset must reproduce exactly — but both `pew reset` and `pew sync` are
 * documented as the recovery path for a damaged queue. A torn write or a stale
 * format must not turn the recovery command into another wall: read what is
 * still usable (a non-negative integer offset, well-formed dirty keys, a string
 * target) and fall back to defaults for the rest.
 */
export async function readIdempotentQueueState(stateDir: string, file: string): Promise<QueueState> {
  let raw: string;
  try { raw = await readFile(join(stateDir, file), "utf8"); }
  catch { return { offset: 0 }; }
  try {
    const state = JSON.parse(raw) as Partial<QueueState>;
    if (state === null || typeof state !== "object") return { offset: 0 };
    const offset = state.offset;
    return {
      offset: Number.isSafeInteger(offset) && (offset as number) >= 0 ? (offset as number) : 0,
      dirtyKeys: Array.isArray(state.dirtyKeys) && state.dirtyKeys.every((key) => typeof key === "string")
        ? state.dirtyKeys : undefined,
      lastUploadTarget: typeof state.lastUploadTarget === "string" ? state.lastUploadTarget : undefined,
    };
  } catch { return { offset: 0 }; }
}

/**
 * Lenient JSONL read: keeps every line that parses, skips the rest.
 *
 * A crash mid-append leaves a partial last line. The strict readers treat that
 * as "cannot verify" and refuse, which is why a single torn byte used to block
 * `pew reset` — the command whose whole job is to survive this. Records that
 * did parse are still complete and keep their retained-source guarantee.
 */
export async function readIdempotentQueueRows<T>(stateDir: string, file: string): Promise<T[]> {
  let raw: string;
  try { raw = await readFile(join(stateDir, file), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rows: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { /* torn or corrupt line */ }
  }
  return rows;
}
