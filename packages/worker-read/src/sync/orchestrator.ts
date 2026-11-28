/**
 * Orchestrates one full dynamic-pricing sync run on the worker side.
 *
 * Single entry point used by both the cron handler (C3) and the admin
 * rebuild endpoint (C6) — composing them through the same function avoids
 * silent drift between manual and scheduled refreshes.
 *
 * Partial-success policy (intentionally distinct from C2's all-or-nothing
 * baseline-refresh CLI):
 * - Each upstream is fetched independently with a 20-second timeout.
 * - On success → fresh JSON is used; it is cached via writeLastFetch only
 * after the run wins the newer-publication guard, so a discarded run
 * cannot poison the cache a newer run wrote.
 * - On failure → fall back to the source's `pricing:last-fetch:*` if any.
 * Push a {source, message} entry into errors regardless.
 * - On failure with no cache → feed [] for that source into merge; the
 * bundled baseline still floors the output.
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
  readDynamicResult,
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
  /** Upstream produced a usable document; the caller caches it once the run publishes. */
  fresh?: boolean;
  /**
  * A cheap rebuild found no usable cache. The stored layer must not be erased
  * just because there is no fetch document to re-parse.
  */
  preservePrevious?: boolean;
}

type ParseFn = (
  json: unknown,
  now: string,
) => { entries: DynamicPricingEntry[]; warnings: string[] };

/**
 * Whether a document actually yields entries the merge can use.
 *
 * Upstreams answer200 with an error document behind their own gateways
 * (OpenRouter does: `{"error":{"message":"temporary catalogue failure"}}`).
 * Shape checks alone were not enough: `{"data":[]}` and a models.dev catalogue
 * whose every model lacks `cost` both satisfied them, parsed to zero entries,
 * and were counted as successes — the merge then rewrote that source's layer
 * as empty and the prices it had learned vanished until the next good fetch.
 * A document that parses to zero entries is therefore a FAILED fetch: no cache
 * write, old layer preserved, `ok=false`.
 */
function documentYieldsEntries(parse: ParseFn, json: unknown, now: string): boolean {
  try {
    return parse(json, now).entries.length > 0;
  } catch {
    return false;
  }
}

export interface SyncOptions {
  /**
  * Controls upstream-fetch policy:
  * - undefined (cron default): fetch upstream, fall back to last-fetch cache on failure.
  * - false (cheap rebuild): skip upstream fetch entirely; merge from last-fetch cache + baseline.
  * - true ("Force sync now"): always fetch upstream; do NOT fall back to cache on failure (operator wants fresh).
  */
  forceRefetch?: boolean;
}

async function resolveSource(
  source: LastFetchSource,
  url: string,
  now: string,
  deps: SyncDeps,
  forceRefetch: boolean | undefined,
  parse: ParseFn,
): Promise<FetchResolution> {
  // Cheap-rebuild path: do not hit upstream. Use cached JSON if any.
  if (forceRefetch === false) {
    const cached = await readLastFetch(deps.kv, source);
    // A cache written before this guard existed can hold an error document or
    // a shape that parses to nothing; treat it as no cache rather than feeding
    // it to the merge as this source's whole layer.
    if (cached && documentYieldsEntries(parse, cached.json, now)) {
      return { json: cached.json, fromCache: true, error: null };
    }
    // No cache, but the published layer may still hold prices this source
    // learned. It is re-fed below instead of being erased by an empty merge.
    return { json: null, fromCache: false, error: null, preservePrevious: true };
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!documentYieldsEntries(parse, json, now)) {
      throw new Error("HTTP 200 without a usable document");
    }
    // Cached by syncDynamicPricing only after it decides to publish: a run
    // that is discarded as older than the published result must not overwrite
    // the last-fetch entry the newer run wrote.
    return { json, fromCache: false, error: null, fresh: true };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // forceRefetch=true → operator wants fresh; do not silently substitute stale cache.
    if (forceRefetch === true) {
      return { json: null, fromCache: false, error: message };
    }
    const cached = await readLastFetch(deps.kv, source);
    if (cached && documentYieldsEntries(parse, cached.json, now)) {
      return { json: cached.json, fromCache: true, error: message };
    }
    return { json: null, fromCache: false, error: message };
  }
}

export async function syncDynamicPricing(
  deps: SyncDeps,
  now: string,
  options?: SyncOptions,
): Promise<SyncOutcome> {
  const forceRefetch = options?.forceRefetch;
  const errors: SyncError[] = [];

  const [orRes, mdRes] = await Promise.all([
      resolveSource("openrouter", OPENROUTER_URL, now, deps, forceRefetch, parseOpenRouter),
      resolveSource("models.dev", MODELS_DEV_URL, now, deps, forceRefetch, parseModelsDev),
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
  const sourceFailed =
  orRes.error !== null ||
  mdRes.error !== null ||
  orRes.preservePrevious === true ||
  mdRes.preservePrevious === true;
  // The failure-preservation merge below rebuilds a failed source's layer from
  // the stored catalogue. If that read itself errors, an empty layer would
  // publish baseline + cache over history and lose every price the store had
  // learned. Refuse to publish instead — the stored catalogue stays intact and
  // the next run retries.
  let previousDynamic: DynamicPricingEntry[] = [];
  if (sourceFailed) {
    const stored = await readDynamicResult(deps.kv);
    if (stored.status === "error") {
      const message = "dynamic pricing kv read error key=pricing:dynamic";
      const skippedReason = "the stored pricing layer could not be read (KV error); the published catalogue was left untouched";
      const published = await readMeta(deps.kv);
      return {
        ok: false,
        entriesWritten: 0,
        meta: published ?? {
          lastSyncedAt: now, modelCount: 0, baselineCount: (baseline as DynamicPricingEntry[]).length,
          openRouterCount: 0, modelsDevCount: 0,
          lastErrors: [...errors.map((e) => ({ ...e, at: now })), { source: "kv" as const, at: now, message }],
        },
        warnings: [`pricing: ${skippedReason}`],
        errors: [...errors, { source: "kv", message }],
        skippedReason,
      };
    }
    previousDynamic = stored.value ?? [];
  }
  const priorLayer = (origin: DynamicPricingEntry["origin"]) =>
  previousDynamic.filter((entry) => entry.origin === origin);
  const layerFor = (
    origin: DynamicPricingEntry["origin"],
    resolution: FetchResolution,
    parse: ParseFn,
  ): { entries: DynamicPricingEntry[]; warnings: string[] } => {
    const failed = resolution.error !== null || resolution.preservePrevious === true;
    if (!failed) {
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
      const restorable = Object.entries(stored.routePrices).filter(
        ([route, rates]) =>
        (orRes.error !== null && route === "openrouter") ||
        (mdRes.error !== null && route === "models.dev" && rates.origin === "models.dev"),
      );
      if (restorable.length === 0) continue;
      // The published route prices win: the other side of this spread can be a
      // re-parsed last-fetch cache from an older fetch, and letting it override
      // rolled a newer price back for the model's whole route.
      entry.routePrices = { ...(entry.routePrices ?? {}), ...Object.fromEntries(restorable) };
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

  // Publish the fetched documents now that this run is allowed to publish.
  // Writing them inside resolveSource put an older run's document into the
  // cache even when the run itself was discarded, and a later upstream failure
  // then re-parsed that stale document back over the newer prices.
  if (orRes.fresh && orRes.json !== null) {
    await writeLastFetch(deps.kv, "openrouter", { json: orRes.json, fetchedAt: now });
  }
  if (mdRes.fresh && mdRes.json !== null) {
    await writeLastFetch(deps.kv, "models.dev", { json: mdRes.json, fetchedAt: now });
  }

  // Build meta first so we can attempt to write both entries and meta atomically
  // (best-effort: if either write fails we surface kv error and ok=false).
  const buildMeta = (): DynamicPricingMeta => ({
      ...merged.meta,
      lastErrors: errors.length
      ? errors.map((e) => ({ source: e.source, at: now, message: e.message }))
      : null,
  });

  let dynamicWritten = true;
  try {
    await writeDynamicOrThrow(deps.kv, merged.entries);
  } catch (err) {
    dynamicWritten = false;
    const message = (err as Error).message ?? String(err);
    console.error("dynamic pricing kv write error key=pricing:dynamic:", err);
    errors.push({ source: "kv", message });
  }

  let meta: DynamicPricingMeta;
  if (!dynamicWritten) {
    // Meta and prices must describe the same generation. Advancing lastSyncedAt
    // while the entry write failed served a meta claiming a catalogue the KV
    // does not hold, and the newer-run guard then discarded the next good run
    // for being older than that phantom publication.
    meta = (await readMeta(deps.kv)) ?? buildMeta();
  } else {
    // Re-build meta now that errors may include the entries-write failure.
    meta = buildMeta();
    try {
      await writeMetaOrThrow(deps.kv, meta);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.error("dynamic pricing kv write error key=pricing:dynamic:meta:", err);
      errors.push({ source: "kv", message });
      meta = buildMeta();
    }
  }

  return {
    ok: errors.length === 0,
    entriesWritten: dynamicWritten ? merged.entries.length : 0,
    meta,
    warnings: [...orParse.warnings, ...mdParse.warnings, ...merged.warnings],
    errors,
  };
}
