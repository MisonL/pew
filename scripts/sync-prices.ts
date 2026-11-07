#!/usr/bin/env bun
/**
 * sync-prices — fetch OpenRouter + models.dev, merge with prior baseline,
 * write packages/worker-read/src/data/model-prices.json.
 *
 * This is the developer-facing one-shot baseline refresh. Both upstreams must
 * succeed; partial output would silently bake an incomplete picture into the
 * checked-in file. (The runtime cron path in C3 takes the opposite stance.)
 *
 * Usage:
 *   bun run sync-prices
 *   bun run sync-prices --dry-run
 *   bun run sync-prices --allow-removals
 *   bun run sync-prices --fixture <dir>
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import {
  parseModelsDev,
  type ParseResult as ModelsDevParse,
} from "../packages/worker-read/src/sync/models-dev";
import {
  parseOpenRouter,
  type ParseResult as OpenRouterParse,
} from "../packages/worker-read/src/sync/openrouter";
import { mergePricingSources } from "../packages/worker-read/src/sync/merge";
import type {
  DynamicPricingEntry,
  DynamicPricingMeta,
} from "../packages/worker-read/src/sync/types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT = resolve(
  __dirname,
  "../packages/worker-read/src/data/model-prices.json"
);

export interface SyncOptions {
  dryRun: boolean;
  allowRemovals: boolean;
  fixtureDir: string | null;
  outputPath: string;
  now: string;
}

export interface SyncResult {
  entries: DynamicPricingEntry[];
  meta: Omit<DynamicPricingMeta, "lastErrors">;
  warnings: string[];
  removedModels: string[];
}

async function loadJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

function loadFixture(dir: string, name: string): unknown {
  const file = resolve(dir, name);
  if (!existsSync(file)) throw new Error(`fixture missing: ${file}`);
  return JSON.parse(readFileSync(file, "utf-8"));
}

/**
 * The checked-in baseline is both the merge floor (models an upstream dropped
 * this run keep their last known prices) and the regression signal compared
 * against upstream IDs. Treating an unreadable file as [] disabled the
 * `--allow-removals` exit-2 guard and let the merged output overwrite the file
 * with only the models both upstreams happen to list right now — every other
 * entry and its fallback pricing lost behind one stderr line.
 */
function loadPriorBaseline(path: string): DynamicPricingEntry[] {
  // Only a missing file means "first run". Any other read failure (EACCES, a
  // corrupt checkout) must abort instead of silently reshaping the baseline.
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read prior baseline ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`prior baseline ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`prior baseline ${path} is not a JSON array`);
  }
  return parsed as DynamicPricingEntry[];
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  let openRouterJson: unknown;
  let modelsDevJson: unknown;

  if (opts.fixtureDir) {
    openRouterJson = loadFixture(opts.fixtureDir, "openrouter.json");
    modelsDevJson = loadFixture(opts.fixtureDir, "models-dev.json");
  } else {
    [openRouterJson, modelsDevJson] = await Promise.all([
      loadJson(OPENROUTER_URL),
      loadJson(MODELS_DEV_URL),
    ]);
  }

  const orParse: OpenRouterParse = parseOpenRouter(openRouterJson, opts.now);
  const mdParse: ModelsDevParse = parseModelsDev(modelsDevJson, opts.now);

  const prior = loadPriorBaseline(opts.outputPath);
  const merged = mergePricingSources({
    baseline: prior,
    openRouter: orParse.entries,
    modelsDev: mdParse.entries,
    now: opts.now,
  });

  // Regression signal: any prior model not seen in either upstream this run.
  // Compares against upstream IDs (not merged output) so the baseline floor
  // doesn't mask upstream churn. Alias-aware: a prior bare ID is "covered"
  // when some upstream `provider/X` has X === priorId, since merge would
  // alias-expand it to the bare name.
  const upstreamIds = new Set<string>();
  const upstreamSuffixes = new Set<string>();
  for (const e of [...orParse.entries, ...mdParse.entries]) {
    upstreamIds.add(e.model);
    const slash = e.model.indexOf("/");
    if (slash >= 0) upstreamSuffixes.add(e.model.slice(slash + 1));
  }
  const removedModels = prior
    .map((e) => e.model)
    .filter((id) => !upstreamIds.has(id) && !upstreamSuffixes.has(id))
    .sort();

  // Preserve prior updatedAt when nothing meaningful changed — keeps re-runs
  // diff-free against the checked-in baseline file.
  const priorById = new Map(prior.map((e) => [e.model, e]));
  const content = (value: unknown) => JSON.stringify(value, (key, v) => key === "updatedAt" ? undefined : v);
  const stabilized = merged.entries.map((e) => {
    const prev = priorById.get(e.model);
    if (!prev) return e;
    const routePrices = e.routePrices && Object.fromEntries(Object.entries(e.routePrices).map(([route, rates]) => {
      const previous = prev.routePrices?.[route];
      return [route, previous && content(previous) === content(rates) ? previous : rates];
    }));
    return { ...e, ...(routePrices ? { routePrices } : {}),
      updatedAt: content(prev) === content(e) ? prev.updatedAt : e.updatedAt };
  });

  return {
    entries: stabilized,
    meta: merged.meta,
    warnings: [...orParse.warnings, ...mdParse.warnings, ...merged.warnings],
    removedModels,
  };
}

interface CliArgs {
  dryRun: boolean;
  allowRemovals: boolean;
  fixtureDir: string | null;
  outputPath: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    dryRun: false,
    allowRemovals: false,
    fixtureDir: null,
    outputPath: DEFAULT_OUTPUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--allow-removals":
        out.allowRemovals = true;
        break;
      case "--fixture":
        out.fixtureDir = argv[++i] ?? null;
        if (!out.fixtureDir) throw new Error("--fixture requires a directory argument");
        break;
      case "--output": {
        // A trailing `--output` used to fall back to the checked-in baseline
        // path, turning a typo into a rewrite of the repository's pricing data.
        const value = argv[++i];
        if (!value) throw new Error("--output requires a file path argument");
        out.outputPath = value;
        break;
      }
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const now = new Date().toISOString();
  let result: SyncResult;
  try {
    result = await runSync({ ...args, now });
  } catch (err) {
    console.error(`sync failed: ${(err as Error).message}`);
    return 1;
  }
  if (result.entries.length === 0) {
    console.error("produced 0 entries — refusing to write");
    return 1;
  }

  if (result.removedModels.length > 0) {
    if (!args.allowRemovals) {
      console.error(
        `regression: ${result.removedModels.length} model(s) removed — pass --allow-removals to accept:`
      );
      for (const id of result.removedModels) console.error(`  - ${id}`);
      return 2;
    }
    for (const id of result.removedModels) console.log(`REMOVED: ${id}`);
  }

  for (const w of result.warnings) console.warn(`warn: ${w}`);
  console.log(
    `entries=${result.entries.length} baseline=${result.meta.baselineCount} openrouter=${result.meta.openRouterCount} modelsDev=${result.meta.modelsDevCount}`
  );

  if (args.dryRun) {
    console.log("dry-run: not writing");
    return 0;
  }

  mkdirSync(dirname(args.outputPath), { recursive: true });
  // Write-then-rename: a crash or ENOSPC mid-write leaves the checked-in
  // baseline untouched instead of truncated to a partial JSON document (which
  // the next run would then refuse to read, correctly, but with no way
  // forward except restoring from git).
  const tmpPath = `${args.outputPath}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(result.entries, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, args.outputPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    throw err;
  }
  console.log(`wrote ${args.outputPath}`);
  return 0;
}

const isDirectRun = import.meta.main ?? import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
