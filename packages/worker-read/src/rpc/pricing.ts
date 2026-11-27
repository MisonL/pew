/**
 * Pricing domain RPC handlers for worker-read.
 *
 * Handles pricing-related read queries for the dynamic pricing dataset.
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import baseline from "../data/model-prices.json";
import { readDynamic, readMetaResult } from "../sync/kv-store";
import { syncDynamicPricing, type SyncOutcome } from "../sync/orchestrator";
import type { DynamicPricingEntry, DynamicPricingMeta } from "../sync/types";

// ---------------------------------------------------------------------------
// RPC Request Types
// ---------------------------------------------------------------------------

export interface GetDynamicPricingRequest {
  method: "pricing.getDynamicPricing";
}

export interface GetDynamicPricingMetaRequest {
  method: "pricing.getDynamicPricingMeta";
}

export interface RebuildDynamicPricingRequest {
  method: "pricing.rebuildDynamicPricing";
  forceRefetch?: boolean;
}

export type PricingRpcRequest =
  | GetDynamicPricingRequest
  | GetDynamicPricingMetaRequest
  | RebuildDynamicPricingRequest;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const BASELINE_ENTRIES = baseline as DynamicPricingEntry[];

async function handleGetDynamicPricing(kv: KVNamespace): Promise<Response> {
  const stored = await readDynamic(kv);
  if (stored && stored.length > 0) {
    return Response.json({ result: { entries: stored, servedFrom: "kv" } });
  }
  return Response.json({
    result: { entries: BASELINE_ENTRIES, servedFrom: "baseline" },
  });
}

async function handleGetDynamicPricingMeta(kv: KVNamespace): Promise<Response> {
  const read = await readMetaResult(kv);
  if (read.status === "ok" && read.value) {
    return Response.json({ result: read.value });
  }
  // "missing" is an instance that has never synced; "error" is KV being
  // unreadable right now, which the old collapsed-null path reported with the
  // same cold-start text — an admin saw the benign message during an outage.
  const synthesized: DynamicPricingMeta = {
    lastSyncedAt: "1970-01-01T00:00:00.000Z",
    modelCount: BASELINE_ENTRIES.length,
    baselineCount: BASELINE_ENTRIES.length,
    openRouterCount: 0,
    modelsDevCount: 0,
    lastErrors: [
      {
        source: "kv",
        at: new Date().toISOString(),
        message: read.status === "error"
          ? "KV unreadable (storage error)"
          : "KV empty (cold start)",
      },
    ],
  };
  return Response.json({ result: synthesized });
}

async function handleRebuildDynamicPricing(
  req: RebuildDynamicPricingRequest,
  db: D1Database,
  kv: KVNamespace
): Promise<Response> {
  const outcome: SyncOutcome = await syncDynamicPricing(
    { db, kv },
    new Date().toISOString(),
    { forceRefetch: req.forceRefetch }
  );
  return Response.json({ result: outcome });
}

export async function handlePricingRpc(
  request: PricingRpcRequest,
  db: D1Database,
  kv: KVNamespace
): Promise<Response> {
  switch (request.method) {
    case "pricing.getDynamicPricing":
      return handleGetDynamicPricing(kv);
    case "pricing.getDynamicPricingMeta":
      return handleGetDynamicPricingMeta(kv);
    case "pricing.rebuildDynamicPricing":
      return handleRebuildDynamicPricing(request, db, kv);
    default:
      return Response.json(
        { error: `Unknown pricing method: ${(request as { method: string }).method}` },
        { status: 400 }
      );
  }
}
