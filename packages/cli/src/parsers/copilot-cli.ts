import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { TokenDelta } from "@pew/core";
import { jsonlStreamBound } from "../utils/jsonl-offset.js";
import { isAllZero, toNonNegInt } from "../utils/token-delta.js";
import type { ParsedDelta } from "./claude.js";

/** Result of parsing a single GitHub Copilot CLI process log file */
export interface CopilotCliFileResult {
  deltas: ParsedDelta[];
  endOffset: number;
}

/**
 * Parse a GitHub Copilot CLI process log file incrementally from a byte offset.
 *
 * Log format: Each telemetry block starts with a line containing
 * `[Telemetry] cli.telemetry:` followed by a multi-line JSON object.
 * We extract `assistant_usage` events which carry per-request token counts.
 *
 * Token fields (disjoint for estimateCost / total_tokens SUM):
 *   metrics.input_tokens_uncached → inputTokens (preferred)
 *   else max(0, input_tokens - cache_read_tokens)
 *   metrics.cache_read_tokens     → cachedInputTokens
 *   metrics.output_tokens         → outputTokens
 *
 * `input_tokens` from the telemetry is the total including cache hits;
 * storing it alongside cache_read would double-count.
 */
export async function parseCopilotCliFile(opts: {
  filePath: string;
  startOffset: number;
  endBound?: number;
}): Promise<CopilotCliFileResult> {
  const { filePath, startOffset } = opts;
  const deltas: ParsedDelta[] = [];

  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) return { deltas, endOffset: startOffset };

  const fileSize = jsonlStreamBound(st.size, opts.endBound);
  if (startOffset >= fileSize) return { deltas, endOffset: fileSize };

  // Line endings are counted from the bytes actually consumed, not from a
  // width probed once. The old probe read the first 4 KB and assumed every
  // line used that ending: a CRLF log whose first line is longer than the
  // probe reported LF, so each line under-counted a byte, endOffset fell short
  // of EOF, and the next sync re-read (and, with no dedup here, re-emitted)
  // the tail. Mixed-ending files had the same drift in either direction.
  const stream = createReadStream(filePath, {
    start: startOffset,
    end: fileSize - 1,
  });

  // Timestamp pattern that starts a new log line
  const LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  const TELEMETRY_MARKER = "[Telemetry] cli.telemetry:";

  let collectingJson = false;
  let jsonLines: string[] = [];

  // Track byte position relative to startOffset for safe endOffset.
  // If the file ends mid-JSON-block, we rewind to the last fully
  // parsed position so the incomplete block gets re-parsed next sync.
  let bytesConsumed = 0;
  let lastCompletedOffset = startOffset;
  let pending: Buffer = Buffer.alloc(0);

  /**
   * Try to parse the accumulated JSON lines.
   * Returns true if parse succeeded (or lines were empty), false if
   * the buffer looks incomplete (JSON.parse threw SyntaxError).
   */
  function tryFlushJson(): boolean {
    if (jsonLines.length === 0) return true;
    const raw = jsonLines.join("\n");
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.kind === "assistant_usage") {
        const delta = extractUsageDelta(parsed);
        if (delta) deltas.push(delta);
      }
      jsonLines = [];
      return true;
    } catch {
      // Could be incomplete JSON (still accumulating) or truly malformed
      return false;
    }
  }

  /** One complete line (EOL already stripped); `bytesConsumed` is updated by the caller. */
  function handleLine(line: string): void {
    if (LOG_LINE_RE.test(line)) {
      // New log line — flush any in-progress JSON block first
      if (collectingJson) {
        // Force-flush: a new log line means the JSON block ended (or was malformed).
        // tryFlushJson clears jsonLines on success; on failure the block was
        // malformed and we discard it below.
        tryFlushJson();
        jsonLines = [];
        collectingJson = false;
      }

      if (line.includes(TELEMETRY_MARKER)) {
        collectingJson = true;
        // Do NOT advance lastCompletedOffset past the marker line.
        // If the JSON block that follows is incomplete (file truncated),
        // we need to rewind to BEFORE this marker so the next sync
        // re-reads it and re-enters collectingJson mode.
      } else {
        // Non-telemetry log line — safe to advance past it
        lastCompletedOffset = startOffset + bytesConsumed;
      }
      return;
    }

    if (!collectingJson) return;
    jsonLines.push(line);

    // Attempt JSON.parse after each line containing "}" — this is
    // more robust than brace-depth counting which breaks on braces
    // inside JSON string values.
    if (line.includes("}")) {
      const parsed = tryFlushJson();
      if (parsed) {
        collectingJson = false;
        lastCompletedOffset = startOffset + bytesConsumed;
      }
      // If parse failed, keep accumulating — might be nested object
    }
  }

  try {
    for await (const chunk of stream) {
      const piece: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      pending = pending.length === 0 ? piece : Buffer.concat([pending, piece]);
      let offset = 0;
      for (;;) {
        const nl = pending.indexOf(0x0a, offset);
        if (nl === -1) break;
        // Strip the trailing \r of a CRLF pair, matching readline's crlfDelay.
        const end = nl > offset && pending[nl - 1] === 0x0d ? nl - 1 : nl;
        const line = pending.subarray(offset, end).toString("utf8");
        bytesConsumed += nl - offset + 1; // includes the \n on disk
        handleLine(line);
        offset = nl + 1;
      }
      pending = pending.subarray(offset);
    }
  } finally {
    stream.destroy();
  }

  // A trailing unterminated line is left unread: it may still be written to,
  // and consuming it would risk parsing half a record.
  //
  // Do NOT flush trailing incomplete blocks — leave them for next sync.
  // A pending marker means its JSON body has not been fully consumed: either
  // nothing has been written after it yet or only part of it. Both must rewind
  // to before the marker, because the next sync only re-enters collectingJson
  // mode by re-reading it; a body that arrives later would otherwise look like
  // ordinary non-log lines and be skipped forever.
  const consumed = Math.min(startOffset + bytesConsumed, fileSize);
  const endOffset = collectingJson ? lastCompletedOffset : consumed;

  return { deltas, endOffset };
}

/**
 * Extract a ParsedDelta from an `assistant_usage` telemetry event.
 * Returns null if the event has no usable token data or missing timestamp.
 */
function extractUsageDelta(
  event: Record<string, unknown>,
): ParsedDelta | null {
  const props = event.properties as Record<string, unknown> | undefined;
  const metrics = event.metrics as Record<string, unknown> | undefined;

  // Require created_at for idempotent uploads — skip events without it.
  // Using current time as fallback would break reset+sync idempotency.
  const timestamp =
    typeof event.created_at === "string" && event.created_at.length > 0
      ? event.created_at
      : null;
  if (!timestamp) return null;

  const model =
    typeof props?.model === "string" && props.model.length > 0
      ? props.model
      : "unknown";

  const tokens = normalizeCopilotCliUsage(metrics ?? {});
  if (isAllZero(tokens)) return null;

  return { source: "copilot-cli", model, timestamp, tokens };
}

/**
 * Normalize Copilot CLI telemetry metrics to disjoint TokenDelta fields.
 *
 * Prefer `input_tokens_uncached` when present (modern logs). Fall back to
 * max(0, input_tokens - cache_read_tokens) for older telemetry that only
 * reports inclusive input_tokens.
 */
export function normalizeCopilotCliUsage(
  metrics: Record<string, unknown>,
): TokenDelta {
  const cached = toNonNegInt(metrics.cache_read_tokens);
  const inputUncached = metrics.input_tokens_uncached;
  // Prefer explicit uncached field when present and numeric (including 0).
  // Fall back when the key is absent or non-numeric (e.g. string garbage).
  const hasUncached =
    inputUncached !== undefined &&
    inputUncached !== null &&
    Number.isFinite(Number(inputUncached)) &&
    Number(inputUncached) >= 0;

  const inputTokens = hasUncached
    ? toNonNegInt(inputUncached)
    : Math.max(0, toNonNegInt(metrics.input_tokens) - cached);

  return {
    inputTokens,
    cachedInputTokens: cached,
    outputTokens: toNonNegInt(metrics.output_tokens),
    reasoningOutputTokens: 0,
  };
}
