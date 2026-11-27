/**
 * Generic factory for ingest route handlers.
 *
 * Eliminates boilerplate duplication between the token and session
 * ingest routes. Each route becomes a thin wrapper that supplies:
 *   - a per-record validator (from @pew/core)
 *   - the Worker URL resolver
 *   - a human-readable entity name for error messages
 *
 * Env vars (WORKER_INGEST_URL, WORKER_SECRET) are read lazily inside
 * the handler for testability — no module-scope process.env reads.
 */

import { NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth-helpers";
import { MAX_INGEST_BATCH_SIZE, MAX_INGEST_BODY_BYTES, MIN_CLIENT_VERSION, BodyTooLargeError, readBoundedJson, isRetiredSourceRecord } from "@pew/core";
import type { AccountingAck, ValidationResult } from "@pew/core";
import {
  INGEST_RATE_LIMIT,
  clientIpKey,
  inMemoryRateLimiter,
} from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Worker URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Worker URL for an ingest route from WORKER_INGEST_URL.
 *
 * The variable is configured in two shapes: with the `/ingest` route suffix
 * (Cloudflare workers.dev deployments, and the E2E runner, which injects
 * `${base}/ingest`) and without it (the selfhost compose default
 * `http://ingest:8786`). A trailing slash must also be tolerated. All four
 * ingest routes derive from this one normalization: the token route used to
 * take the raw value, so the selfhost default fetched the Worker root and
 * 404'd every token upload — masked in tests only because the E2E runner
 * injects the suffixed form.
 */
export function resolveIngestUrl(kind: "tokens" | "sessions" | "evidence" | "details"): string {
  const base = (process.env.WORKER_INGEST_URL ?? "").replace(/\/+$/, "").replace(/\/ingest(?:\/tokens)?$/, "");
  return kind === "tokens" ? `${base}/ingest` : `${base}/ingest/${kind}`;
}

// ---------------------------------------------------------------------------
// Worker forward deadline
// ---------------------------------------------------------------------------

/**
 * Deadline for the forward to the ingest Worker.
 *
 * Without it a stalled Worker pins the Node request until undici's 300s
 * default; 60s matches the bound db-worker.ts already puts on worker-read
 * RPCs. Read lazily like the other env vars in this module, so tests can
 * lower it per case.
 */
export const DEFAULT_INGEST_FORWARD_TIMEOUT_MS = 60_000;

export function ingestForwardTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.INGEST_FORWARD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INGEST_FORWARD_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Factory config
// ---------------------------------------------------------------------------

export interface IngestHandlerConfig<T> {
  /**
   * Per-record validator returning a discriminated union.
   * Imported from @pew/core (validateIngestRecord / validateSessionIngestRecord).
   */
  validateRecord: (r: unknown, index: number) => ValidationResult<T>;

  /**
   * Resolve the Worker URL at call time (reads env lazily).
   * Routes use resolveIngestUrl() above so all four agree on the
   * WORKER_INGEST_URL shapes (with/without `/ingest`, trailing slash).
   */
  getWorkerUrl: () => string;

  /** Human-readable entity name used in error messages, e.g. "records" or "session records" */
  entityName: string;
  maxBodyBytes?: number;
  maxBatchSize?: number;
  /**
   * Per-process cap on how many of these uploads may be in flight.
   *
   * The accounting route accepts 24 MB bodies; each one is buffered, parsed
   * and re-serialized before the forward, so an unbounded number of them is
   * hundreds of MB on one process. Excess requests are refused with 503 so
   * the client retries instead of queueing more bodies into memory.
   */
  maxConcurrent?: number;
  /** A versioned route can project an explicit receipt instead of legacy {ingested}. */
  acknowledgment?: (body: unknown, records: T[]) => { details_version: 1; acknowledgments: AccountingAck[] } | null;
  retiredAcknowledgment?: (record: unknown) => AccountingAck | null;
  /**
   * Receipt field naming: token/evidence routes let the Worker report dropped
   * revoked-device records under `dropped_devices`; session routes keep the
   * legacy `{ ingested }` shape. When set, the Worker response body is passed
   * through so a drop is not reported as a successful write.
   */
  receiptName?: "dropped_devices";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a POST handler for an ingest route.
 *
 * The returned function has the signature Next.js expects for route handlers:
 *   `(request: Request) => Promise<Response>`
 */
export function createIngestHandler<T>(
  config: IngestHandlerConfig<T>,
): (request: Request) => Promise<Response> {
  const { validateRecord, getWorkerUrl, entityName } = config;

  // Named `handlePost`, not `POST`: biome's noComponentHookFactories rule reads
  // a capitalized inner function name as a React component factory. The
  // exported route name is supplied by the caller (`export const POST = ...`).
  const handlePostInner = async function handlePost(request: Request): Promise<Response> {
    // 1. Authenticate
    const authResult = await resolveUser(request);
    if (!authResult) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId } = authResult;

    // 2. Rate limit: 300 per minute per user
    // (falls back to client IP if userId is somehow empty; the fallback keys
    // through clientIpKey so IPv6 rotation cannot mint fresh buckets)
    const rateKey = userId || `ip:${clientIpKey(request)}`;
    const rl = inMemoryRateLimiter.check(
      `ingest:${rateKey}`,
      INGEST_RATE_LIMIT,
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
      );
    }

    // 3. Version gate — require a supported CLI before forwarding any data
    const clientVersion = request.headers.get("X-Pew-Client-Version");
    if (!clientVersion || compareSemver(clientVersion, MIN_CLIENT_VERSION) < 0) {
      return NextResponse.json(
        {
          error: `Client version too old (received ${clientVersion || "unknown"}; minimum ${MIN_CLIENT_VERSION}). Upgrade: npm install -g @nocoo/pew@latest OR bun add -g @nocoo/pew@latest. Then run: pew sync.`,
        },
        { status: 400 },
      );
    }

    // 4. Parse body
    let records: unknown[];
    try {
      const body = await readBoundedJson(request, config.maxBodyBytes ?? MAX_INGEST_BODY_BYTES);
      if (!Array.isArray(body)) {
        return NextResponse.json(
          { error: "Request body must be an array" },
          { status: 400 },
        );
      }
      records = body;
    } catch (error) {
      if (error instanceof BodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    // 5. Validate batch constraints
    if (records.length === 0) {
      return NextResponse.json(
        { error: "Request body must not be empty" },
        { status: 400 },
      );
    }

    const maxBatchSize = config.maxBatchSize ?? MAX_INGEST_BATCH_SIZE;
    if (records.length > maxBatchSize) {
      return NextResponse.json(
        {
          error: `Batch too large: max ${maxBatchSize} records per request`,
        },
        { status: 400 },
      );
    }

    // 6. Validate individual records
    const validated: T[] = [];
    const acknowledgmentOrder: Array<number | AccountingAck | null> = [];
    let ignored = 0;
    for (let i = 0; i < records.length; i++) {
      if (isRetiredSourceRecord(records[i])) {
        ignored++;
        acknowledgmentOrder.push(config.retiredAcknowledgment?.(records[i]) ?? null);
        continue;
      }
      const result = validateRecord(records[i], i);
      if (!result.valid) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      acknowledgmentOrder.push(validated.length);
      validated.push(result.record);
    }

    const counts = { ingested: validated.length, ...(ignored ? { ignored } : {}) };
    const withRetiredReceipts = (receipt: { details_version: 1; acknowledgments: AccountingAck[] }) => ({
      ...receipt,
      acknowledgments: acknowledgmentOrder.flatMap((slot) => slot === null ? [] : typeof slot === "number" ? [receipt.acknowledgments[slot]] : [slot]),
      ...(ignored ? counts : {}),
    });
    if (validated.length === 0) {
      return NextResponse.json(config.acknowledgment
        ? withRetiredReceipts({ details_version: 1, acknowledgments: [] }) : counts);
    }

    // 7. Forward to Worker for atomic batch upsert
    const workerUrl = getWorkerUrl();
    const workerSecret = process.env.WORKER_SECRET ?? "";

    try {
      const res = await fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify({ userId, records: validated }),
        // Covers the body read too: aborting after the headers arrive makes
        // res.json() reject instead of hanging.
        signal: AbortSignal.timeout(ingestForwardTimeoutMs()),
      });

      if (!res.ok) {
        // Upstream bodies/exceptions can include credentials or submitted
        // values, so the response text is not echoed wholesale. The STATUS,
        // however, is load-bearing:
        //  - a Worker 400 means the two validators drifted (the web layer ran
        //    the same core rules before forwarding). Its message names the
        //    rejected source/record, which is what lets the CLI peel that
        //    source out and keep the queue moving instead of retrying the
        //    whole batch every sync — that message is derived from the
        //    caller's own submission, so echoing it leaks nothing new;
        //  - 413 is permanent for the same bytes: retrying cannot help;
        //  - 503 is the Worker saying "not configured / not now".
        console.error(`Worker ${entityName} ingest failed (${res.status})`);
        const upstreamError = res.status === 400
          ? ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error
          : undefined;
        const message = typeof upstreamError === "string" && upstreamError.length > 0 && upstreamError.length <= 500
          ? upstreamError
          : `Failed to ingest ${entityName}`;
        const status = res.status === 400 || res.status === 413 || res.status === 503
          ? res.status
          : res.status === 429
            ? 429
            : 500;
        return NextResponse.json(
          { error: message },
          {
            status,
            ...(status === 503 || status === 429 ? { headers: { "Retry-After": "1" } } : {}),
          },
        );
      }
      if (config.acknowledgment) {
        const receipt = config.acknowledgment(await res.json().catch(() => null), validated);
        if (!receipt) return NextResponse.json({ error: "Worker did not acknowledge this accounting protocol" }, { status: 502 });
        return NextResponse.json(withRetiredReceipts(receipt));
      }
      if (config.receiptName) {
        // The Worker's receipt is authoritative: `ingested` is what actually
        // applied, and `dropped_devices` names the revoked devices the guard
        // discarded. Synthesizing `ingested: validated.length` here is what
        // reported a revoked device's records as written. Retired-source
        // records were already filtered out above, so their skip count still
        // comes from this side.
        //
        // An unreadable receipt is NOT a fallback case: answering with the
        // synthesized count would claim an apply nobody confirmed, and the
        // CLI would clear records the server may have dropped. Fail so the
        // client retries (the upserts are idempotent).
        const receipt = await res.json().catch(() => null);
        if (typeof receipt !== "object" || receipt === null) {
          console.error(`Worker ${entityName} ingest returned an unreadable receipt`);
          return NextResponse.json({ error: `Failed to ingest ${entityName}` }, { status: 502 });
        }
        return NextResponse.json({ ...receipt as Record<string, unknown>, ...(ignored ? { ignored } : {}) });
      }
    } catch {
      console.error(`Failed to ingest ${entityName}`);
      return NextResponse.json(
        { error: `Failed to ingest ${entityName}` },
        { status: 500 },
      );
    }

    return NextResponse.json(counts);
  };

  const limit = config.maxConcurrent;
  if (limit === undefined) return handlePostInner;

  let inFlight = 0;
  return async function handlePost(request: Request): Promise<Response> {
    if (inFlight >= limit) {
      // Refuse rather than queue: the queue would be the memory this cap
      // exists to bound. The client's upload loop retries a 503.
      return NextResponse.json(
        { error: "Too many concurrent uploads; retry shortly" },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    inFlight++;
    try {
      return await handlePostInner(request);
    } finally {
      inFlight--;
    }
  };
}

// ---------------------------------------------------------------------------
// Semver comparison (minimal — handles "major.minor.patch" only)
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 *
 * Non-numeric or missing segments are treated as 0.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}
