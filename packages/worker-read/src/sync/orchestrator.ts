/**
 * Orchestrates one full dynamic-pricing sync run on the worker side.
 *
 * Single entry point used by both the cron handler (C3) and the admin
 * rebuild endpoint (C6) — composing them through the same function avoids
 * silent drift between manual and scheduled refreshes.
 *
 * Partial-success policy (intentionally distinct from C2's all-or-nothing
 * baseline-refresh CLI):
 *   - Each upstream is fetched independently with a 20 s timeout.
 *   - On success → fresh JSON is used and immediately cached via
 *     writeLastFetch so a future failure can fall back to it.
 *   - On failure → fall back to the source's `pricing:last-fetch:*` if any.
 *     Push a {source, message} entry into errors regardless.
 *   - On failure with no cache → feed [] for that source into merge; the
 *     bundled baseline still floors the output.
 *
 * KV write is best-effort and logged; merged entries are still returned to
 * the caller even if KV writes fail — that's what the SyncOutcome carries.
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

import baseline from "../data/model-prices.json";
import { mergePricingSources } from "./merge";
import { parseModelsDev } from "./models-dev";
import { parseOpenRouter } from "./openrouter";
import {
  readDynamic,
  readLastFetch,
  readMeta,
  writeDynamicOrThrow,
  writeLastFetch,
  writeMetaOrThrow,
  type LastFetchSource,
} from "./kv-store";
import type { DynamicPricingEntry, DynamicPricingMeta } from "./types";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
export const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 20_000;

type SyncErrorSource = "openrouter" | "models.dev" | "kv";

interface SyncError {
  source: SyncErrorSource;
  message: string;
}

export interface SyncOutcome {
  ok: boolean;
  entriesWritten: number;
  meta: DynamicPricingMeta;
  warnings: string[];
  errors: SyncError[];
  /**
   * Set when the run deliberately published nothing. `ok` alone cannot carry
   * this: a discarded run has no errors, so every caller that branches on `ok`
   * — the cron's "sync ok" log, the admin button's "Prices updated" — reported
   * a success that did not happen.
   */
  skippedReason?: string;
}

export interface SyncDeps {
  db: D1Database;
  kv: KVNamespace;
  fetchImpl?: typeof fetch;
}

interface FetchResolution {
  json: unknown | null;
  fromCache: boolean;
  error: string | null;
}

/**
 * Whether a 200 body is the document the parser expects.
 *
 * Upstreams answer 200 with an error document behind their own gateways
 * (OpenRouter does: `{"error":{"message":"temporary catalogue failure"}}`).
 * Caching that body and letting the parser degrade it to a warning counted the
 * run as a success, so the source's layer was rewritten as empty and the
 * prices it had learned vanished until the next good fetch. A body that is not
 * the expected document is therefore a FAILED fetch — no cache write, old
 * layer preserved, `ok=false`.
 */
function payloadIsUsable(source: LastFetchSource, json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  if (source === "openrouter") return Array.isArray((json as { data?: unknown }).data);
  // models.dev answers a provider → { models: {...} } catalogue. An error
  // document has no such entry, so requiring one keeps a total shape change
  // from being read as "every model was retired". `typeof models === "object"`
  // is true for null and for arrays as well, and a provider block that carries
  // either is not a catalogue: it satisfied the old test, was cached as a good
  // fetch, parsed to zero entries, and the merge erased the models.dev layer.
  return Object.values(json as Record<string, unknown>).some((provider) => {
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) return false;
    const models = (provider as { models?: unknown }).models;
    return models !== null && typeof models === "object" && !Array.isArray(models) &&
      Object.keys(models as Record<string, unknown>).length > 0;
  });
}

export interface SyncOptions {
  /**
   * Controls upstream-fetch policy:
   *   - undefined (cron default): fetch upstream, fall back to last-fetch cache on failure.
   *   - false (cheap rebuild): skip upstream fetch entirely; merge from last-fetch cache + baseline.
   *   - true ("Force sync now"): always fetch upstream; do NOT fall back to cache on failure (operator wants fresh).
   */
  forceRefetch?: boolean;
}

async function resolveSource(
  source: LastFetchSource,
  url: string,
  now: string,
  deps: SyncDeps,
  forceRefetch: boolean | undefined
): Promise<FetchResolution> {
  // Cheap-rebuild path: do not hit upstream. Use cached JSON if any.
  if (forceRefetch === false) {
    const cached = await readLastFetch(deps.kv, source);
    // A cache written before this guard existed can hold an error document;
    // treat it as no cache rather than feeding it to the parser.
    if (cached && payloadIsUsable(source, cached.json)) {
      return { json: cached.json, fromCache: true, error: null };
    }
    return { json: null, fromCache: false, error: null };
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!payloadIsUsable(source, json)) {
      throw new Error("HTTP 200 without the expected document");
    }
    await writeLastFetch(deps.kv, source, { json, fetchedAt: now });
    return { json, fromCache: false, error: null };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // forceRefetch=true → operator wants fresh; do not silently substitute stale cache.
    if (forceRefetch === true) {
      return { json: null, fromCache: false, error: message };
    }
    const cached = await readLastFetch(deps.kv, source);
    if (cached) {
      return { json: cached.json, fromCache: true, error: message };
    }
    return { json: null, fromCache: false, error: message };
  }
}

export async function syncDynamicPricing(
  deps: SyncDeps,
  now: string,
  options?: SyncOptions
): Promise<SyncOutcome> {
  const forceRefetch = options?.forceRefetch;
  const errors: SyncError[] = [];

  const [orRes, mdRes] = await Promise.all([
    resolveSource("openrouter", OPENROUTER_URL, now, deps, forceRefetch),
    resolveSource("models.dev", MODELS_DEV_URL, now, deps, forceRefetch),
  ]);

  if (orRes.error) errors.push({ source: "openrouter", message: orRes.error });
  if (mdRes.error) errors.push({ source: "models.dev", message: mdRes.error });

  // The bundled baseline is a floor, not a replacement. A source that failed
  // this run must not erase what the last successful run stored for it: entries
  // that exist only upstream would silently vanish from the served map and stay
  // gone until the next success. Those entries are re-fed as that source's
  // layer, so a success still replaces them wholesale while a failure keeps
  // them at their last known prices.
  //
  // The stored layer wins over the last-fetch cache, not the other way round: a
  // cache document holds only what THAT fetch saw, so re-parsing it dropped
  // every entry learned since (a price learned two syncs later vanished the
  // first time this source hiccupped). The cache is a bootstrap for an instance
  // whose stored layer is empty, nothing more.
  const sourceFailed = orRes.error !== null || mdRes.error !== null;
  const previousDynamic = sourceFailed ? (await readDynamic(deps.kv)) ?? [] : [];
  const priorLayer = (origin: DynamicPricingEntry["origin"]) =>
    previousDynamic.filter((entry) => entry.origin === origin);
  const layerFor = (
    origin: DynamicPricingEntry["origin"],
    resolution: FetchResolution,
    parse: (json: unknown, now: string) => { entries: DynamicPricingEntry[]; warnings: string[] }
  ): { entries: DynamicPricingEntry[]; warnings: string[] } => {
    if (resolution.error === null) {
      return resolution.json === null ? { entries: [], warnings: [] } : parse(resolution.json, now);
    }
    const prior = priorLayer(origin);
    if (prior.length > 0) return { entries: prior, warnings: [] };
    return resolution.json === null ? { entries: [], warnings: [] } : parse(resolution.json, now);
  };

  const orParse = layerFor("openrouter", orRes, parseOpenRouter);
  const mdParse = layerFor("models.dev", mdRes, parseModelsDev);

  const merged = mergePricingSources({
    baseline: baseline as DynamicPricingEntry[],
    openRouter: orParse.entries,
    modelsDev: mdParse.entries,
    now,
  });

  // Restore the alternate-route prices a failed source had contributed. When
  // models.dev is the primary for a model and OpenRouter only an alternate
  // route, the OpenRouter rates live in that entry's `routePrices`, not in an
  // entry of their own — so re-feeding only `origin === "openrouter"` entries
  // left them out, and one failed OpenRouter fetch silently dropped the
  // OpenRouter route for every such model until OpenRouter recovered.
  if (sourceFailed) {
    const storedByModel = new Map(previousDynamic.map((entry) => [entry.model, entry]));
    for (const entry of merged.entries) {
      const stored = storedByModel.get(entry.model);
      if (!stored?.routePrices) continue;
      const restorable = Object.entries(stored.routePrices).filter(([route, rates]) =>
        (orRes.error !== null && route === "openrouter") ||
        (mdRes.error !== null && route === "models.dev" && rates.origin === "models.dev"),
      );
      if (restorable.length === 0) continue;
      entry.routePrices = { ...Object.fromEntries(restorable), ...entry.routePrices };
    }
  }

  // A run must not publish over a result that is already NEWER than its own
  // start time. The scheduler's single-flight only covers its own invocation;
  // an admin "Refresh prices" runs this orchestrator beside it, and whichever
  // finished last used to win — so a slow stale fetch replaced the fresh
  // catalogue with older prices. Both backends store the publication time in
  // the meta, and both are last-write-wins, so this is a read-then-write guard
  // that narrows the window to the gap between the read and the put rather
  // than eliminating it; it is a strict improvement and cheap.
  const published = await readMeta(deps.kv);
  if (published?.lastSyncedAt && Date.parse(published.lastSyncedAt) > Date.parse(now)) {
    const skippedReason = `a newer sync (${published.lastSyncedAt}) is already published; this run's result was discarded`;
    const warnings = [`pricing: ${skippedReason}`];
    return { ok: errors.length === 0, entriesWritten: 0, meta: { ...published }, warnings, errors, skippedReason };
  }

  // Build meta first so we can attempt to write both entries and meta atomically
  // (best-effort: if either write fails we surface kv error and ok=false).
  const buildMeta = (): DynamicPricingMeta => ({
    ...merged.meta,
    lastErrors: errors.length
      ? errors.map((e) => ({ source: e.source, at: now, message: e.message }))
      : null,
  });

  try {
    await writeDynamicOrThrow(deps.kv, merged.entries);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error("dynamic pricing kv write error key=pricing:dynamic:", err);
    errors.push({ source: "kv", message });
  }

  // Re-build meta now that errors may include the entries-write failure.
  let meta = buildMeta();
  try {
    await writeMetaOrThrow(deps.kv, meta);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error("dynamic pricing kv write error key=pricing:dynamic:meta:", err);
    errors.push({ source: "kv", message });
    meta = buildMeta();
  }

  return {
    ok: errors.length === 0,
    entriesWritten: merged.entries.length,
    meta,
    warnings: [...orParse.warnings, ...mdParse.warnings, ...merged.warnings],
    errors,
  };
}
