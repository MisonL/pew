import type { TokenDelta } from "@pew/core";

/**
 * Floor a timestamp to the nearest half-hour UTC boundary.
 * Returns ISO string like "2026-03-07T10:00:00.000Z" or "2026-03-07T10:30:00.000Z".
 * Returns null if the timestamp is unparseable.
 *
 * Computed from epoch milliseconds rather than `Date.UTC(getUTCFullYear(), …)`
 * so it is byte-identical to the server's own derivation
 * (`new Date(Math.floor(time / 1_800_000) * 1_800_000).toISOString()` in
 * core's evidence validator). The component form disagreed on two inputs: it
 * remapped years 0000–0099 to 1900+year (ECMAScript's two-digit rule for
 * `Date.UTC`), silently filing such a bucket in the wrong century, and it
 * preserved a >= 10000 year that the canonical `hour_start` contract rejects.
 */
export function toUtcHalfHourStart(ts: string | number): string | null {
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(Math.floor(time / 1_800_000) * 1_800_000).toISOString();
}

/**
 * Create a composite bucket key from source, model, and half-hour start.
 * Format: "source|model|hourStart"
 */
export function bucketKey(
  source: string,
  model: string,
  hourStart: string,
): string {
  return `${source}|${model}|${hourStart}`;
}

/** Create a TokenDelta with all zeros */
export function emptyTokenDelta(): TokenDelta {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

/** Add delta values into target in place */
export function addTokens(target: TokenDelta, delta: TokenDelta): void {
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
}
