import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NotifierOperationResult, NotifierStatus } from "@pew/core";

interface CodexNotifierFs {
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile: (path: string, data: string, encoding: BufferEncoding) => Promise<unknown>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  unlink: (path: string) => Promise<unknown>;
}

export interface CodexNotifierOptions {
  configPath: string;
  notifyPath: string;
  originalBackupPath: string;
  /**
   * Runtime executable to launch the notify handler. Defaults to
   * `process.execPath` — see doc 45 §7.2. DI keeps installer decisions
   * out of the runtime environment.
   */
  runtimePath?: string;
  fs?: CodexNotifierFs;
}

const SOURCE = "codex";
const LEGACY_ENV_PREFIX = ["/usr/bin/env", "node"] as const;

export async function installCodexNotifier(
  opts: CodexNotifierOptions,
): Promise<NotifierOperationResult> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir, unlink };
  const runtimePath = opts.runtimePath ?? process.execPath;
  const text = await readOptional(opts.configPath, fs);
  if (text === null) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Codex config.toml not found",
    };
  }

  const notify = buildNotifyCommand(opts.notifyPath, runtimePath);
  const existingNotify = extractNotify(text);
  if (existingNotify.notAnArray) {
    // A top-level `notify` that is not an array is not a command this
    // installer can save and restore. Overwriting it would destroy the value
    // and uninstall would then delete the key outright.
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail:
        "ownership_conflict: top-level notify is not an array; refusing to overwrite it",
      warnings: [
        "Inspect the top-level `notify` in config.toml and remove it manually if it is no longer needed.",
      ],
    };
  }
  const existingCommand = existingNotify.command;
  const existingBackup = await readOptional(opts.originalBackupPath, fs);

  // Happy path: no backup on disk. Save the existing command (unless it's
  // Pew-owned in a legacy shape — never self-backup) and take the slot.
  if (existingBackup === null) {
    if (arraysEqual(existingCommand, notify)) {
      return {
        source: SOURCE,
        action: "install",
        changed: false,
        detail: "Codex notifier already installed",
      };
    }
    if (existingCommand && existingCommand.length > 0 && !isPewOwnedCommand(existingCommand, opts.notifyPath)) {
      // Only capture a non-Pew original; a legacy /usr/bin/env node pew
      // command is an in-place migration, not a foreign notifier.
      await fs.mkdir(dirname(opts.originalBackupPath), { recursive: true });
      await fs.writeFile(
        opts.originalBackupPath,
        `${JSON.stringify({ notify: existingCommand, capturedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    }
    const updated = setNotify(text, notify);
    const backupPath = `${opts.configPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.writeFile(backupPath, text, "utf8");
    await fs.writeFile(opts.configPath, updated, "utf8");
    return {
      source: SOURCE,
      action: "install",
      changed: true,
      detail: "Codex notifier installed",
      backupPath,
    };
  }

  // Backup already exists. Only proceed to reclaim the slot if the current
  // top-level command is Pew-owned (the expected pre-migration state);
  // otherwise Pew was displaced and stayed displaced, and re-writing the
  // slot would seed the Issue #318 cycle.
  if (arraysEqual(existingCommand, notify)) {
    return {
      source: SOURCE,
      action: "install",
      changed: false,
      detail: "Codex notifier already installed",
    };
  }
  if (!existingCommand || !isPewOwnedCommand(existingCommand, opts.notifyPath)) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail:
        "ownership_conflict: codex_notify_original.json exists but top-level notify is not Pew-owned; refusing to reclaim the slot",
      warnings: [
        "Manual review needed: inspect config.toml notify and " +
          "codex_notify_original.json, then delete the backup once resolved.",
      ],
    };
  }

  // Migration from legacy Pew command to new runtime command.
  const updated = setNotify(text, notify);
  const backupPath = `${opts.configPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.writeFile(backupPath, text, "utf8");
  await fs.writeFile(opts.configPath, updated, "utf8");
  return {
    source: SOURCE,
    action: "install",
    changed: true,
    detail: "Codex notifier migrated to runtime-path command",
    backupPath,
  };
}

export async function uninstallCodexNotifier(
  opts: CodexNotifierOptions,
): Promise<NotifierOperationResult> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir, unlink };
  const runtimePath = opts.runtimePath ?? process.execPath;
  const text = await readOptional(opts.configPath, fs);
  if (text === null) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Codex config.toml not found",
    };
  }

  const existingNotify = extractNotify(text);
  const expectedNotify = buildNotifyCommand(opts.notifyPath, runtimePath);
  const existingCommand = existingNotify.command;
  const isCurrentPewOwned =
    existingCommand !== null && isPewOwnedCommand(existingCommand, opts.notifyPath);
  if (!arraysEqual(existingCommand, expectedNotify) && !isCurrentPewOwned) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Codex notifier not installed",
    };
  }

  const originalBackup = await readOptional(opts.originalBackupPath, fs);
  let originalNotify: string[] | null = null;
  let backupParseError: string | null = null;
  if (originalBackup !== null) {
    try {
      const parsed = JSON.parse(originalBackup) as { notify?: string[] };
      if (
        Array.isArray(parsed.notify) &&
        parsed.notify.every((v) => typeof v === "string")
      ) {
        originalNotify = parsed.notify;
      } else {
        backupParseError = "backup missing valid `notify` string[] field";
      }
    } catch (err) {
      backupParseError =
        err instanceof Error ? `backup JSON parse failed: ${err.message}` : "backup JSON parse failed";
    }
  }

  // Doc 45 §8: backup exists on disk but we can't understand its contents.
  // Refuse to touch either config or backup so the user can inspect the
  // original file manually — silently removing the notify line and then
  // deleting the corrupted backup would destroy the only trace of the
  // saved-original command.
  if (backupParseError !== null) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: `codex_notify_original.json unreadable — ${backupParseError}; not touching config or backup`,
      warnings: [
        "Inspect codex_notify_original.json manually. Once it's fixed or intentionally removed, re-run pew uninstall --source=codex.",
      ],
    };
  }

  // Cycle validation: refuse to restore a saved-original whose command
  // points at Pew's own notify.cjs. Keep the backup around for manual
  // inspection instead of silently reseeding Issue #318.
  if (originalNotify && isPewOwnedCommand(originalNotify, opts.notifyPath)) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail:
        "cycle_detected: codex_notify_original.json refers back to Pew notify.cjs; not restoring",
      warnings: [
        "Preserved codex_notify_original.json for manual review — delete it once you've verified the callback graph is acyclic.",
      ],
    };
  }

  const updated = originalNotify ? setNotify(text, originalNotify) : removeNotify(text);
  const backupPath = `${opts.configPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.writeFile(backupPath, text, "utf8");
  await fs.writeFile(opts.configPath, updated, "utf8");

  // Only remove the backup file after the config write succeeded.
  if (originalBackup !== null) {
    try {
      await fs.unlink(opts.originalBackupPath);
    } catch {
      // Best-effort — user can delete manually.
    }
  }

  return {
    source: SOURCE,
    action: "uninstall",
    changed: true,
    detail: originalNotify ? "Codex notifier restored" : "Codex notifier removed",
    backupPath,
  };
}

export async function getCodexNotifierStatus(
  opts: CodexNotifierOptions,
): Promise<NotifierStatus> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir, unlink };
  const text = await readOptional(opts.configPath, fs);
  if (text === null) return "not-installed";
  const existing = extractNotify(text);
  return existing.command !== null && isPewOwnedCommand(existing.command, opts.notifyPath)
    ? "installed"
    : "not-installed";
}

function buildNotifyCommand(notifyPath: string, runtimePath: string): string[] {
  return [runtimePath, notifyPath, "--source=codex"];
}

/**
 * Recognises any command that launches Pew's own notify.cjs:
 *   - New runtime form:      [<any-runtime>, <notifyPath>, --source=codex]
 *   - Legacy env form:       ["/usr/bin/env", "node", <notifyPath>, --source=codex]
 * Anything else (including foreign wrappers that happen to end in
 * --source=codex) is NOT considered Pew-owned.
 */
function isPewOwnedCommand(cmd: readonly string[], notifyPath: string): boolean {
  const findIndex = cmd.indexOf(notifyPath);
  if (findIndex === -1) return false;
  // New runtime shape: [runtime, notifyPath, --source=codex, ...]
  if (findIndex === 1) return true;
  // Legacy shape: [/usr/bin/env, node, notifyPath, --source=codex, ...]
  if (
    findIndex === 2 &&
    cmd[0] === LEGACY_ENV_PREFIX[0] &&
    cmd[1] === LEGACY_ENV_PREFIX[1]
  ) {
    return true;
  }
  return false;
}

async function readOptional(
  filePath: string,
  fs: CodexNotifierFs,
): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * What the top-level `notify` key holds. TOML is table-scoped: `notify` is
 * Pew's slot only before the first `[table]` header. A `notify` inside
 * `[model_providers.custom]` belongs to that provider, and reading,
 * replacing or deleting it corrupts the user's config — the previous line
 * scan matched the first `notify =` anywhere in the file.
 */
interface TopLevelNotify {
  /** The command, when the value is a complete string array. */
  command: string[] | null;
  /**
   * A top-level `notify` exists whose value is not an array at all (e.g.
   * `notify = true`). Such a value cannot be saved and restored, so overwriting
   * it would destroy it and uninstalling would delete the key outright.
   */
  notAnArray: boolean;
}

/** A complete `[table]` / `[[array.of.tables]]` header on one line. */
const TOML_TABLE_HEADER = /^\s*\[\[?[^\]]*\]\]?\s*(?:#.*)?$/;

function extractNotify(text: string): TopLevelNotify {
  const lines = text.split(/\r?\n/);
  const found = findTopLevelNotify(lines);
  if (!found) return { command: null, notAnArray: false };
  // A value that never closes (`notify = [` with no `]`) is left to the
  // lenient in-place replace below; only a non-array value blocks the write.
  if (!found.rhs.startsWith("[")) return { command: null, notAnArray: true };

  const literal = readTomlArrayLiteral(lines, found.index, found.rhs);
  const values = literal === null ? null : parseTomlStringArray(literal);
  return { command: values, notAnArray: false };
}

/**
 * Locate the top-level `notify` assignment. Stops at the first table header:
 * everything after it is table-scoped and not ours. A non-header line that
 * starts with `[` (e.g. `[1, 2],` inside a multi-line array) does not match
 * TOML_TABLE_HEADER, so an array continuation cannot end the scan early.
 */
function findTopLevelNotify(lines: string[]): { index: number; rhs: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (TOML_TABLE_HEADER.test(line)) return null;
    const match = line.match(/^\s*notify\s*=\s*(.*)$/);
    if (match) return { index: i, rhs: (match[1] ?? "").trim() };
  }
  return null;
}

function setNotify(text: string, notify: string[]): string {
  const lines = text.split(/\r?\n/);
  const replacement = `notify = ${formatTomlStringArray(notify)}`;
  const found = findTopLevelNotify(lines);

  if (!found) {
    // Top-level keys must precede the first table header; appending after a
    // table would make the key part of that table.
    const headerIndex = lines.findIndex((line) => TOML_TABLE_HEADER.test(line));
    const insertAt = headerIndex === -1 ? trailingBlankStart(lines) : headerIndex;
    lines.splice(insertAt, 0, replacement);
  } else {
    const end = findTomlArrayBlockEnd(lines, found.index, found.rhs);
    lines.splice(found.index, end - found.index + 1, replacement);
  }

  return normalizeTomlText(lines);
}

function removeNotify(text: string): string {
  const lines = text.split(/\r?\n/);
  const found = findTopLevelNotify(lines);
  if (!found) return normalizeTomlText(lines);

  const end = findTomlArrayBlockEnd(lines, found.index, found.rhs);
  lines.splice(found.index, end - found.index + 1);
  return normalizeTomlText(lines);
}

/** Index of the first trailing blank line, so appends land before it. */
function trailingBlankStart(lines: string[]): number {
  let at = lines.length;
  while (at > 0 && (lines[at - 1] ?? "").trim() === "") at--;
  return at;
}

function normalizeTomlText(lines: string[]): string {
  const joined = lines.join("\n").replace(/\n+$/, "");
  return joined === "" ? "" : `${joined}\n`;
}

/**
 * Parse a TOML string array literal, e.g. `["a", "b", 'c']`.
 *
 * Handles all TOML escape sequences in double-quoted strings:
 *   `\"` `\\` `\n` `\t` `\r` `\b` `\f` `\uXXXX` `\UXXXXXXXX`
 *
 * Single-quoted strings are literal (no escape processing), per the TOML spec.
 */
function parseTomlStringArray(text: string): string[] | null {
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];

  const parts: string[] = [];
  let current = "";
  let inString = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (!inString) {
      if (char === '"' || char === "'") {
        inString = true;
        quote = char;
        current = "";
      }
      continue;
    }

    // Handle backslash escapes in double-quoted strings only
    if (quote === '"' && char === "\\") {
      const next = inner[i + 1];
      if (next === '"') { current += '"'; i++; continue; }
      if (next === "\\") { current += "\\"; i++; continue; }
      if (next === "n") { current += "\n"; i++; continue; }
      if (next === "t") { current += "\t"; i++; continue; }
      if (next === "r") { current += "\r"; i++; continue; }
      if (next === "b") { current += "\b"; i++; continue; }
      if (next === "f") { current += "\f"; i++; continue; }

      // \uXXXX — 4-digit Unicode escape
      if (next === "u") {
        const hex = inner.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          current += String.fromCodePoint(parseInt(hex, 16));
          i += 5; // skip \uXXXX
          continue;
        }
      }

      // \UXXXXXXXX — 8-digit Unicode escape
      if (next === "U") {
        const hex = inner.slice(i + 2, i + 10);
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
          const codePoint = parseInt(hex, 16);
          if (codePoint <= 0x10FFFF) {
            current += String.fromCodePoint(codePoint);
            i += 9; // skip \UXXXXXXXX
            continue;
          }
        }
      }

      // Unknown escape: preserve the backslash as-is (defensive)
      current += char;
      continue;
    }

    if (char === quote) {
      parts.push(current);
      inString = false;
      quote = null;
      continue;
    }

    current += char;
  }

  return parts.length > 0 ? parts : null;
}

function formatTomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function readTomlArrayLiteral(
  lines: string[],
  startIndex: number,
  rhs: string,
): string | null {
  if (!rhs.startsWith("[")) return null;

  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  const chunks: string[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const chunk = i === startIndex ? rhs : lines[i];
    chunks.push(chunk.trim());

    for (let j = 0; j < chunk.length; j++) {
      const char = chunk[j];
      if (!inString) {
        if (char === '"' || char === "'") {
          inString = true;
          quote = char;
          continue;
        }
        if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
        continue;
      }

      // Skip escaped characters in double-quoted strings
      if (quote === '"' && char === "\\" && j + 1 < chunk.length) {
        j++; // skip the next character
        continue;
      }

      if (char === quote) {
        inString = false;
        quote = null;
      }
    }

    if (depth === 0) return chunks.join(" ");
  }

  return null;
}

function findTomlArrayBlockEnd(lines: string[], startIndex: number, rhs: string): number {
  if (!rhs.startsWith("[")) return startIndex;

  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;

  for (let i = startIndex; i < lines.length; i++) {
    const chunk = i === startIndex ? rhs : lines[i];
    for (let j = 0; j < chunk.length; j++) {
      const char = chunk[j];
      if (!inString) {
        if (char === '"' || char === "'") {
          inString = true;
          quote = char;
          continue;
        }
        if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
        continue;
      }
      // Skip escaped characters in double-quoted strings
      if (quote === '"' && char === "\\" && j + 1 < chunk.length) {
        j++;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = null;
      }
    }
    if (depth === 0) return i;
  }

  return startIndex;
}

function arraysEqual(left: string[] | null, right: string[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
