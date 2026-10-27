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

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse a single Grok session directory into a SessionSnapshot.
 *
 * Returns null on missing/corrupt summary or missing session id.
 *
 * Note: totalMessages uses summary.num_chat_messages (not num_messages) —
 * num_messages counts system events in updates.jsonl.
 */
export async function parseGrokSession(
  sessionDir: string,
): Promise<SessionSnapshot | null> {
  const [summary, signals] = await Promise.all([
    readJson(join(sessionDir, "summary.json")),
    readJson(join(sessionDir, "signals.json")),
  ]);

  if (!summary) return null;

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
