import type { QueueRecord } from "@pew/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedDelta } from "../parsers/claude.js";
import { toUtcHalfHourStart } from "./buckets.js";
import { isRetiredSource } from "./retired-sources.js";

export const tokenRecordKey = (r: QueueRecord): string =>
  `${r.source}|${r.model}|${r.hour_start}|${r.device_id}`;

/**
 * Read the Antigravity partition plus retained retired-source records.
 *
 * `tolerant` is for the self-healing paths (`pew sync`, `pew reset`): a torn
 * tail line or a malformed record is skipped instead of aborting the whole
 * command. Retired records are carried through the rebuild either way; the
 * strict default keeps the "cannot verify" guarantee for everything else.
 */
export async function readAntigravityBaseline(
  stateDir: string,
  includeRetired = false,
  opts: { tolerant?: boolean } = {},
): Promise<QueueRecord[]> {
  let raw: string;
  try { raw = await readFile(join(stateDir, "queue.jsonl"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Cannot verify previous usage queue"); }
  try {
    return parseBaselineRows(raw, includeRetired, opts.tolerant === true);
  } catch { throw new Error("Cannot verify previous usage queue"); }
}

function parseBaselineRows(raw: string, includeRetired: boolean, tolerant: boolean): QueueRecord[] {
  const lines = raw.split("\n").filter(Boolean);
  const rows: QueueRecord[] = [];
  for (const line of lines) {
    let parsed: QueueRecord;
    try { parsed = JSON.parse(line) as QueueRecord; }
    catch { if (tolerant) continue; throw new Error(); }
    if (!parsed || typeof parsed !== "object" || typeof parsed.source !== "string") {
      if (tolerant) continue;
      throw new Error();
    }
    rows.push(parsed);
  }
  const retained = rows.filter((r) => r.source === "antigravity" || includeRetired && isRetiredSource(r.source));
  const valid = (r: QueueRecord): boolean =>
    typeof r.device_id === "string" && typeof r.model === "string" && typeof r.hour_start === "string" &&
    Number.isFinite(Date.parse(r.hour_start)) &&
    [r.input_tokens, r.cached_input_tokens, r.output_tokens, r.reasoning_output_tokens, r.total_tokens]
      .every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) &&
    r.total_tokens === r.input_tokens + r.cached_input_tokens + r.output_tokens + r.reasoning_output_tokens;
  // Filter, never splice in place: removing the current element from the array
  // being iterated skips its successor, so only alternating invalid rows would
  // be dropped and the rest would survive into the rebuilt baseline.
  if (tolerant) return retained.filter(valid);
  if (!retained.every(valid)) throw new Error();
  return retained;
}

export function antigravityRecords(deltas: ParsedDelta[], deviceId: string): QueueRecord[] {
  const records = new Map<string, QueueRecord>();
  for (const d of deltas) {
    const hour = toUtcHalfHourStart(d.timestamp);
    if (d.source !== "antigravity" || !hour || d.evidence) throw new Error("Invalid Antigravity snapshot");
    const next: QueueRecord = { source: d.source, device_id: deviceId, model: d.model, hour_start: hour,
      input_tokens: d.tokens.inputTokens, cached_input_tokens: d.tokens.cachedInputTokens,
      output_tokens: d.tokens.outputTokens, reasoning_output_tokens: d.tokens.reasoningOutputTokens,
      total_tokens: Object.values(d.tokens).reduce((sum, n) => sum + n, 0) };
    const key = tokenRecordKey(next);
    const prior = records.get(key);
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const) {
      const raw = next[field];
      next[field] += prior?.[field] ?? 0;
      if (!Number.isSafeInteger(raw) || raw < 0 || next[field] > 1_000_000_000) {
        throw new Error("Antigravity token limit exceeded");
      }
    }
    records.set(key, next);
  }
  return [...records.values()];
}

export function replaceAntigravityPartition(
  previous: QueueRecord[], afterOtherSources: QueueRecord[], fresh: QueueRecord[] | null, deviceId: string,
): { records: QueueRecord[]; tombstones: QueueRecord[]; changedKeys: string[] } {
  const owned = (r: QueueRecord) => r.source === "antigravity" && r.device_id === deviceId;
  const prior = previous.filter(owned);
  const incoming = fresh ?? prior;
  const keys = new Set(incoming.map(tokenRecordKey));
  const tombstones = fresh === null ? [] : prior.filter((r) => !keys.has(tokenRecordKey(r))).map((r) => ({
    ...r, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
  }));
  const snapshots = [...incoming, ...tombstones];
  const old = new Map(prior.map((r) => [tokenRecordKey(r), r]));
  const fields = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;
  return {
    records: [...afterOtherSources.filter((r) => r.source !== "antigravity"),
      ...previous.filter((r) => r.source === "antigravity" && !owned(r)), ...snapshots],
    tombstones,
    changedKeys: fresh === null ? [] : snapshots.filter((r) => {
      const p = old.get(tokenRecordKey(r));
      return !p || fields.some((k) => p[k] !== r[k]);
    }).map(tokenRecordKey),
  };
}
