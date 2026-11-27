/**
 * Grok CLI session parser.
 *
 * Reads summary.json + signals.json under ~/.grok/sessions/<enc-cwd>/<sid>/.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionSnapshot, Source } from "@pew/core";
import { hashProjectRef } from "../utils/hash-project-ref.js";
import { canonicalInstant, durationSeconds } from "../utils/session-time.js";

/**
 * Read summary.json distinguishing "absent/unparseable" from "present but
 * not readable".
 *
 * The session cursor is keyed by summary.json's own mtime+size. A file that
 * is later rewritten (a repair, new activity) changes that key and gets
 * re-parsed, so a missing or corrupt summary may resolve to null and have
 * its cursor recorded. A read REFUSED by the OS (EACCES/EIO) is different:
 * fixing the permission changes neither mtime nor size, so recording the
 * cursor would skip this session forever with its snapshot never taken.
 * Callers must retry those instead.
 */
async function readSummary(
  path: string,
): Promise<{ state: "ok"; value: Record<string, unknown> | null } | { state: "unreadable" }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "ok", value: null };
    return { state: "unreadable" };
  }
  try {
    return { state: "ok", value: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { state: "ok", value: null };
  }
}

/**
 * Read signals.json distinguishing "absent" from "present but unreadable".
 * An absent file is Grok's own pre-signals state — report zeros now and the
 * real values on the next activity. A present-but-corrupt file means the
 * truth exists and we cannot see it; uploading zeros then would overwrite
 * stored history through the session upsert.
 */
async function readSignals(
  path: string,
): Promise<{ state: "ok"; value: Record<string, unknown> | null } | { state: "unreadable" }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "ok", value: null };
    return { state: "unreadable" };
  }
  try {
    return { state: "ok", value: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { state: "unreadable" };
  }
}/**
 * Parse a single Grok session directory into a SessionSnapshot.
 *
 * Returns null on missing/corrupt summary or missing session id.
 *
 * Throws when signals.json exists but cannot be read. The session cursor is
 * keyed by summary.json's mtime+size, which a signals.json repair does not
 * change; returning null would let session-sync record a cursor for it and
 * fast-skip the session forever. A throw keeps the file retryable, which is
 * what "skip this round" has to mean.
 *
 * Note: totalMessages uses summary.num_chat_messages (not num_messages) —
 * num_messages counts system events in updates.jsonl.
 */
export async function parseGrokSession(
  sessionDir: string,
): Promise<SessionSnapshot | null> {
  const [summaryResult, signalsResult] = await Promise.all([
    readSummary(join(sessionDir, "summary.json")),
    readSignals(join(sessionDir, "signals.json")),
  ]);

  if (summaryResult.state === "unreadable") {
    throw new Error(`${join(sessionDir, "summary.json")} is unreadable; deferring this session until it can be read`);
  }
  const summary = summaryResult.value;
  if (!summary) return null;
  if (signalsResult.state === "unreadable") {
    throw new Error(`${join(sessionDir, "signals.json")} is unreadable; deferring this session until it can be read`);
  }
  const signals = signalsResult.value;

  const info =
    summary.info && typeof summary.info === "object"
      ? (summary.info as Record<string, unknown>)
      : null;
  const sessionId = typeof info?.id === "string" ? info.id : null;
  if (!sessionId) return null;

  // The summary carries whatever Grok wrote, and it can include microsecond
  // precision — canonicalize before the snapshot reaches the queue, where the
  // server compares these strings verbatim.
  const startedAt = canonicalInstant(summary.created_at);
  if (!startedAt) return null;

  const lastMessageAt =
    canonicalInstant(summary.last_active_at) ??
    canonicalInstant(summary.updated_at) ??
    startedAt;

  const duration = clampDuration(
    signals?.sessionDurationSeconds ?? 0,
    startedAt,
    lastMessageAt,
  );
  const userMessages = toNonNeg(signals?.userMessageCount ?? 0);
  const assistantMessages = toNonNeg(signals?.assistantMessageCount ?? 0);
  // Prefer chat messages; fall back to 0 if field missing
  const totalMessages = toNonNeg(summary.num_chat_messages ?? 0);

  const projectRef =
    typeof summary.git_root_dir === "string"
      ? summary.git_root_dir
      : typeof info?.cwd === "string"
        ? info.cwd
        : null;

  const model =
    typeof summary.current_model_id === "string"
      ? summary.current_model_id.trim()
      : null;

  return {
    sessionKey: sessionId,
    source: "grok" as Source,
    kind: "human",
    startedAt,
    lastMessageAt,
    durationSeconds: duration,
    userMessages,
    assistantMessages,
    totalMessages,
    projectRef: hashProjectRef(projectRef),
    model,
    snapshotAt: new Date().toISOString(),
  };
}

function toNonNeg(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Same cap the server enforces (core MAX_RECORD_MESSAGES); an out-of-range
  // counter rejects the whole batch, and a rejected batch never advances the
  // upload offset.
  return Math.min(Math.floor(n), 100_000_000);
}

/**
 * Grok reports its own wall-clock duration; trust it only when it is a
 * finite, in-range number of seconds. Out-of-range values would be rejected
 * by the server and wedge the whole session queue.
 */
function clampDuration(v: unknown, startedAt: string, lastMessageAt: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return durationSeconds(startedAt, lastMessageAt);
  return Math.min(Math.floor(n), 315_576_000);
}
