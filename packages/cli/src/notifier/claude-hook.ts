import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NotifierOperationResult, NotifierStatus } from "@pew/core";
import { shellArg } from "./shell-quote.js";

interface ClaudeHookFs {
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile: (path: string, data: string, encoding: BufferEncoding) => Promise<unknown>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
}

export interface ClaudeHookOptions {
  settingsPath: string;
  notifyPath: string;
  fs?: ClaudeHookFs;
}

const EVENT_NAME = "SessionEnd";
const SOURCE = "claude-code";

export async function installClaudeHook(
  opts: ClaudeHookOptions,
): Promise<NotifierOperationResult> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir };
  const command = buildClaudeHookCommand(opts.notifyPath);
  const accepted = acceptedCommands(opts.notifyPath);
  const loaded = await loadSettings(opts.settingsPath, fs);
  if (loaded.status === "invalid") {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Invalid Claude settings.json",
    };
  }

  const settings = loaded.settings ?? {};
  const hooks = normalizeObject(settings.hooks);
  const entries = normalizeArray(hooks[EVENT_NAME]);

  let changed = false;
  // Upgrade an entry still carrying the legacy double-quoted spelling to the
  // current one in place, so the dangerous form does not survive a reinstall.
  const nextEntries = entries.map((entry) => {
    const normalized = normalizeEntry(entry, command, accepted);
    if (normalized !== entry) changed = true;
    return normalized;
  });

  if (!hasCommand(nextEntries, accepted)) {
    nextEntries.push({
      hooks: [{ type: "command", command }],
    });
    changed = true;
  }

  if (!changed) {
    return {
      source: SOURCE,
      action: "install",
      changed: false,
      detail: "Claude hook already installed",
    };
  }

  const nextSettings = {
    ...settings,
    hooks: {
      ...hooks,
      [EVENT_NAME]: nextEntries,
    },
  };

  const backupPath = await writeSettings(opts.settingsPath, nextSettings, loaded.raw, fs);
  return {
    source: SOURCE,
    action: "install",
    changed: true,
    detail: "Claude hook installed",
    backupPath: backupPath ?? undefined,
  };
}

export async function uninstallClaudeHook(
  opts: ClaudeHookOptions,
): Promise<NotifierOperationResult> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir };
  const accepted = acceptedCommands(opts.notifyPath);
  const loaded = await loadSettings(opts.settingsPath, fs);

  if (loaded.status === "missing") {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Claude settings.json not found",
    };
  }
  if (loaded.status === "invalid" || !loaded.settings) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Invalid Claude settings.json",
    };
  }

  const settings = loaded.settings;
  const hooks = normalizeObject(settings.hooks);
  const entries = normalizeArray(hooks[EVENT_NAME]);
  let removed = false;
  const nextEntries = entries
    .map((entry) => {
      const stripped = stripCommand(entry, accepted);
      if (stripped !== entry) removed = true;
      return stripped;
    })
    .filter(Boolean);

  if (!removed) {
    return {
      source: SOURCE,
      action: "skip",
      changed: false,
      detail: "Claude hook not installed",
    };
  }

  // Rebuild rather than `delete nextHooks[EVENT_NAME]` — the repo's AST gate
  // bans computed deletes, and a spread keeps every other event's entries
  // byte-identical.
  const nextHooks: Record<string, unknown> = {};
  for (const [event, eventEntries] of Object.entries(hooks)) {
    if (event !== EVENT_NAME) nextHooks[event] = eventEntries;
  }
  if (nextEntries.length > 0) nextHooks[EVENT_NAME] = nextEntries;

  const nextSettings = { ...settings };
  if (Object.keys(nextHooks).length > 0) nextSettings.hooks = nextHooks;
  else delete nextSettings.hooks;

  const backupPath = await writeSettings(opts.settingsPath, nextSettings, loaded.raw, fs);
  return {
    source: SOURCE,
    action: "uninstall",
    changed: true,
    detail: "Claude hook removed",
    backupPath: backupPath ?? undefined,
  };
}

export async function getClaudeHookStatus(opts: ClaudeHookOptions): Promise<NotifierStatus> {
  const fs = opts.fs ?? { readFile, writeFile, mkdir };
  const loaded = await loadSettings(opts.settingsPath, fs);
  if (loaded.status === "missing") return "not-installed";
  if (loaded.status === "invalid" || !loaded.settings) return "error";
  return hasCommand(
    normalizeArray(normalizeObject(loaded.settings.hooks)[EVENT_NAME]),
    acceptedCommands(opts.notifyPath),
  )
    ? "installed"
    : "not-installed";
}

/** Both spellings an entry may legitimately carry; see legacyClaudeHookCommand. */
function acceptedCommands(notifyPath: string): string[] {
  return [buildClaudeHookCommand(notifyPath), legacyClaudeHookCommand(notifyPath)];
}

function buildClaudeHookCommand(notifyPath: string): string {
  return `/usr/bin/env node ${shellArg(notifyPath)} --source=${SOURCE}`;
}

/**
 * The command earlier versions wrote: the same argument wrapped in double
 * quotes when it was not shell-safe. Double quotes do not stop `$(...)`, so
 * that spelling is exactly the injection this file no longer produces — but
 * an install already on disk still carries it, and both `status` and
 * `uninstall` must still recognise the entry. Otherwise a reinstall adds a
 * second hook beside the dangerous one and uninstall leaves it behind.
 */
function legacyClaudeHookCommand(notifyPath: string): string {
  const quoted = /^[A-Za-z0-9_\-./:@]+$/.test(notifyPath)
    ? notifyPath
    : `"${notifyPath.replace(/"/g, '\\"')}"`;
  return `/usr/bin/env node ${quoted} --source=${SOURCE}`;
}
async function loadSettings(
  settingsPath: string,
  fs: ClaudeHookFs,
): Promise<
  | { status: "missing"; settings: null; raw: null }
  | { status: "invalid"; settings: null; raw: string | null }
  | { status: "ok"; settings: Record<string, unknown>; raw: string | null }
> {
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "invalid", settings: null, raw };
      }
      return { status: "ok", settings: parsed as Record<string, unknown>, raw };
    } catch {
      return { status: "invalid", settings: null, raw };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { status: "missing", settings: null, raw: null };
    }
    throw err;
  }
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
}

/**
 * Rewrite a Pew-owned entry: add the missing `type: "command"`, and replace a
 * legacy double-quoted command with the current spelling so an existing
 * install is upgraded in place instead of left beside a second hook.
 */
function normalizeEntry(
  entry: Record<string, unknown>,
  command: string,
  accepted: string[],
): Record<string, unknown> {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : null;
  if (!hooks) return entry;

  let changed = false;
  const nextHooks = hooks.map((hook) => {
    if (!hook || typeof hook !== "object") return hook;
    const hookObject = hook as Record<string, unknown>;
    if (typeof hookObject.command !== "string" || !accepted.includes(hookObject.command)) return hookObject;
    if (hookObject.command === command && hookObject.type === "command") return hookObject;
    changed = true;
    return { ...hookObject, type: "command", command };
  });

  return changed ? { ...entry, hooks: nextHooks } : entry;
}

function stripCommand(
  entry: Record<string, unknown>,
  accepted: string[],
): Record<string, unknown> | null {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : null;
  if (!hooks) return entry;

  const nextHooks = hooks.filter((hook) => {
    if (!hook || typeof hook !== "object") return true;
    const value = (hook as Record<string, unknown>).command;
    return !(typeof value === "string" && accepted.includes(value));
  });

  if (nextHooks.length === hooks.length) return entry;
  if (nextHooks.length === 0) return null;
  return { ...entry, hooks: nextHooks };
}

function hasCommand(entries: Record<string, unknown>[], accepted: string[]): boolean {
  return entries.some((entry) => {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.some((hook) => {
      if (!hook || typeof hook !== "object") return false;
      const value = (hook as Record<string, unknown>).command;
      return typeof value === "string" && accepted.includes(value);
    });
  });
}

async function writeSettings(
  settingsPath: string,
  settings: Record<string, unknown>,
  previousRaw: string | null,
  fs: ClaudeHookFs,
): Promise<string | null> {
  const backupPath =
    previousRaw !== null
      ? `${settingsPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`
      : null;

  // dirname, not `new URL(".", `file://${settingsPath}`).pathname`: the URL
  // form percent-encodes the path, so `/Users/John Doe/.claude/settings.json`
  // became `/Users/John%20Doe/.claude/` (a stray directory, and the real
  // settings write then failed with ENOENT), and a `#` truncated it entirely.
  await fs.mkdir(dirname(settingsPath), { recursive: true });

  if (backupPath && previousRaw !== null) {
    await fs.writeFile(backupPath, previousRaw, "utf8");
  }

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return backupPath;
}

