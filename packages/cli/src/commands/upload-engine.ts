/**
 * Generic upload engine — sends queued records to a pew SaaS endpoint.
 *
 * This is the shared pipeline used by both token and session upload commands.
 * It handles:
 * - Config/API-key loading
 * - Queue offset management
 * - Preprocessing (aggregation for tokens, dedup for sessions)
 * - Batching (≤50 records per request, D1 free plan limit)
 * - Retry with exponential backoff on 5xx
 * - 429 rate-limit handling with Retry-After (no double-sleep)
 * - Progress callbacks
 *
 * Bug fixes over the original upload/session-upload:
 * - 429 handler no longer double-sleeps (Retry-After + exponential backoff).
 *   Now the Retry-After sleep replaces the exponential backoff for that attempt.
 */

import { ConfigManager, credentialHostScope } from "../config/manager.js";
import type { BaseQueue } from "../storage/base-queue.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadEngineConfig<T> {
  /** The queue to read records from */
  queue: BaseQueue<T>;
  /** API endpoint path (e.g. "/api/ingest" or "/api/ingest/sessions") */
  endpoint: string;
  /** Human-readable name for progress messages (e.g. "records", "session records") */
  entityName: string;
  /** Pre-processing step: aggregation for tokens, dedup for sessions */
  preprocess: (records: T[]) => T[];
  /**
   * Extract a bucket key from a record for dirty-keys filtering.
   *
   * When provided, the engine uses `dirtyKeys` from queue state to filter
   * records: only records whose key appears in the dirty set are uploaded.
   * When omitted, the engine falls back to offset-based upload (legacy).
   */
  recordKey?: (record: T) => string;
  /** Optional versioned receipt protocol; HTTP 200 alone is insufficient. */
  validateResponse?: (body: unknown, batch: T[]) => string | null;
  /**
   * Return a reason when a record cannot satisfy the server's ingest contract.
   *
   * The server rejects the *whole batch* with 400 when one record is invalid,
   * and a 4xx never advances the upload offset — so one bad record would
   * wedge this queue forever, blocking every record behind it. Dropping it
   * locally with a warning keeps the backlog moving; the raw logs are
   * untouched, so `pew reset && pew sync` rebuilds the queue from source.
   */
  rejectRecord?: (record: T) => string | null;
  maxBatchSize?: number;
  maxBatchBytes?: number;
  /**
   * Persist the upload origin in queue state and warn when pending records
   * are sent to a different origin than the last successful drain. Enable
   * for the user-facing token/session queues only: the queue files are
   * shared across hosts, so a stray PEW_HOST or a dropped --host would
   * otherwise re-route a pending backlog with no line of output saying so.
   */
  trackUploadTarget?: boolean;
}

export interface UploadExecuteOptions {
  /** Directory for config file and queue state */
  stateDir: string;
  /** Base URL of the pew SaaS */
  apiUrl: string;
  /** Whether dev mode is active (uses config.dev.json) */
  dev?: boolean;
  /** Injected fetch (for testing) */
  fetch: typeof globalThis.fetch;
  /** Max records per API request (default: 50) */
  batchSize?: number;
  /** Max retries per batch on 5xx (default: 2) */
  maxRetries?: number;
  /** Base retry delay in ms (default: 1000, doubled each retry) */
  retryDelayMs?: number;
  /** Progress callback */
  onProgress?: (event: UploadProgressEvent) => void;
  /** CLI version string sent as X-Pew-Client-Version header for server-side version gate */
  clientVersion?: string;
}

export interface UploadProgressEvent {
  phase: "uploading" | "done";
  batch?: number;
  totalBatches?: number;
  total?: number;
  message?: string;
}

export interface UploadResult {
  success: boolean;
  uploaded: number;
  batches: number;
  error?: string;
  warning?: string;
  /**
   * Set when this stage actually shipped records to an origin different from
   * the recorded one. The caller composes the warning across stages: a stage
   * with an empty queue ships nothing and therefore cannot re-route anything,
   * but its sibling queues still can.
   */
  targetChangedFrom?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export function createUploadEngine<T>(config: UploadEngineConfig<T>) {
  const { queue, endpoint, entityName, preprocess, recordKey, rejectRecord } = config;

  async function execute(opts: UploadExecuteOptions): Promise<UploadResult> {
    const {
      stateDir,
      apiUrl,
      dev = false,
      fetch: fetchFn,
      batchSize: requestedBatchSize = DEFAULT_BATCH_SIZE,
      maxRetries = DEFAULT_MAX_RETRIES,
      retryDelayMs = DEFAULT_RETRY_DELAY_MS,
      onProgress,
      clientVersion,
    } = opts;

    // 1. Load API key. The host scope is load-bearing: `pew login --host X`
    //    writes to a host-scoped file, and reading the default file here would
    //    either report "Not logged in" for a self-hosted instance or send its
    //    data to the SaaS host under the SaaS token.
    const configManager = new ConfigManager(stateDir, dev, credentialHostScope(apiUrl));
    const cfg = await configManager.load();

    if (!cfg.token) {
      return {
        success: false,
        uploaded: 0,
        batches: 0,
        error: "Not logged in. Run `pew login` first.",
      };
    }

    // 2. Determine upload mode: dirty-keys vs legacy offset-based
    const queueState = await queue.loadState();
    const dirtyKeys = recordKey ? queueState.dirtyKeys : undefined;
    const useDirtyKeys = recordKey && dirtyKeys !== undefined;
    // Reported on every path, including the "nothing of mine to send" ones: a
    // stage with an empty queue ships nothing, but the caller composes one
    // warning across stages and its siblings may still ship the backlog.
    const previousTarget = config.trackUploadTarget ? queueState.lastUploadTarget : undefined;
    const targetChanged = previousTarget !== undefined && previousTarget !== apiUrl;

    // 2a. If dirtyKeys is an empty array, nothing to upload
    if (useDirtyKeys && dirtyKeys.length === 0) {
      return { success: true, uploaded: 0, batches: 0,
        ...(targetChanged ? { targetChangedFrom: previousTarget } : {}) };
    }

    // 2b. Read records — dirty-keys mode always reads from offset 0
    let rawRecords: T[];
    let newOffset: number;
    if (useDirtyKeys) {
      const result = await queue.readFromOffset(0);
      rawRecords = result.records;
      newOffset = result.newOffset;
    } else {
      const currentOffset = await queue.loadOffset();
      const result = await queue.readFromOffset(currentOffset);
      rawRecords = result.records;
      newOffset = result.newOffset;
    }

    // 2c. Filter by dirty keys if applicable
    if (useDirtyKeys) {
      const dirtySet = new Set(dirtyKeys);
      rawRecords = rawRecords.filter((r) => dirtySet.has(recordKey(r)));
    }

    if (rawRecords.length === 0) {
      // Even with zero valid records, advance the offset past any corrupted
      // lines so we don't re-read (and re-warn about) them on every run.
      if (!useDirtyKeys) {
        const currentOffset = await queue.loadOffset();
        if (newOffset !== currentOffset) {
          await queue.saveOffset(newOffset);
        }
      }
      // Clear dirty keys if we're in dirty-keys mode (nothing matched)
      if (useDirtyKeys) {
        await queue.saveDirtyKeys([]);
      }
      return { success: true, uploaded: 0, batches: 0,
        ...(targetChanged ? { targetChangedFrom: previousTarget } : {}) };
    }

    // 2d. Pre-process (aggregate for tokens, dedup for sessions)
    const preprocessed = preprocess(rawRecords);

    // 2e. Drop records the server contract rejects. One such record fails its
    //     whole batch with 400, and a 4xx never advances the offset, so
    //     leaving it in the queue blocks every record behind it forever.
    const rejections: string[] = [];
    const records = rejectRecord
      ? preprocessed.filter((record) => {
          const reason = rejectRecord(record);
          if (reason !== null) rejections.push(reason);
          return reason === null;
        })
      : preprocessed;
    const rejectionWarning = rejections.length > 0
      ? `Skipped ${rejections.length} ${entityName} that cannot pass the upload contract (first: ${rejections[0]}). Source files are untouched; \`pew reset && pew sync\` rebuilds the queue.`
      : undefined;

    if (records.length === 0) {
      // Everything read was rejected: advance past it exactly like the
      // corrupt-line path above, so the same poison is not re-read forever.
      if (!useDirtyKeys) {
        const currentOffset = await queue.loadOffset();
        if (newOffset !== currentOffset) {
          await queue.saveOffset(newOffset);
        }
      }
      if (useDirtyKeys) {
        await queue.saveDirtyKeys([]);
      }
      return { success: true, uploaded: 0, batches: 0,
        ...(rejectionWarning ? { warning: rejectionWarning } : {}),
        ...(targetChanged ? { targetChangedFrom: previousTarget } : {}) };
    }

    // Only warn when something is actually about to ship: an empty backlog
    // cannot be re-routed, and a first-ever upload has no previous target.
    // (`previousTarget`/`targetChanged` are hoisted above the early returns.)

    // 3. Split into batches
    const batchSize = Math.max(1, Math.min(requestedBatchSize, config.maxBatchSize ?? DEFAULT_BATCH_SIZE));
    const batches: T[][] = [];
    let pending: T[] = []; let bytes = 2;
    for (const record of records) {
      const size = config.maxBatchBytes ? Buffer.byteLength(JSON.stringify(record)) + 1 : 0;
      if (config.maxBatchBytes && size + 2 > config.maxBatchBytes) return { success: false, uploaded: 0, batches: 0, error: "Record exceeds the upload byte limit; retained locally" };
      if (pending.length >= batchSize || (pending.length > 0 && config.maxBatchBytes && bytes + size > config.maxBatchBytes)) {
        batches.push(pending); pending = []; bytes = 2;
      }
      pending.push(record); bytes += size;
    }
    if (pending.length > 0) batches.push(pending);

    // 4. Upload each batch
    const fullEndpoint = `${apiUrl}${endpoint}`;
    let totalUploaded = 0;
    let batchesCompleted = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      onProgress?.({
        phase: "uploading",
        batch: batchIdx + 1,
        totalBatches: batches.length,
        total: records.length,
        message: `Uploading ${entityName} batch ${batchIdx + 1}/${batches.length} (${batch.length} records)...`,
      });

      const result = await sendBatchWithRetry({
        endpoint: fullEndpoint,
        token: cfg.token,
        batch,
        fetchFn,
        maxRetries,
        retryDelayMs,
        clientVersion,
        validateResponse: config.validateResponse,
      });

      if (!result.ok) {
        return {
          success: false,
          uploaded: totalUploaded,
          batches: batchesCompleted,
          error: result.error,
          ...(rejectionWarning ? { warning: rejectionWarning } : {}),
        };
      }

      totalUploaded += batch.length;
      batchesCompleted++;
    }

    // 5. All batches succeeded — save state
    await queue.saveOffset(newOffset);
    if (useDirtyKeys) {
      await queue.saveDirtyKeys([]);
    }
    if (config.trackUploadTarget) {
      await queue.saveLastUploadTarget(apiUrl);
    }

    onProgress?.({
      phase: "done",
      total: totalUploaded,
      message: `Uploaded ${totalUploaded} ${entityName} in ${batchesCompleted} batch(es).`,
    });

    const warnings = [
      rejectionWarning,
      targetChanged
        ? `Last successful upload went to ${previousTarget}; this run sent pending ${entityName} to ${apiUrl}.`
        : undefined,
    ].filter((w): w is string => Boolean(w));

    return {
      success: true,
      uploaded: totalUploaded,
      batches: batchesCompleted,
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      ...(targetChanged ? { targetChangedFrom: previousTarget } : {}),
    };
  }

  return { execute };
}

// ---------------------------------------------------------------------------
// Internal: send a single batch with retry
// ---------------------------------------------------------------------------

interface SendResult {
  ok: boolean;
  error?: string;
}

async function sendBatchWithRetry<T>(opts: {
  endpoint: string;
  token: string;
  batch: T[];
  fetchFn: typeof globalThis.fetch;
  maxRetries: number;
  retryDelayMs: number;
  clientVersion?: string;
  validateResponse?: (body: unknown, batch: T[]) => string | null;
}): Promise<SendResult> {
  const { endpoint, token, batch, fetchFn, maxRetries, retryDelayMs, clientVersion } = opts;

  let lastError = "";
  let sleptFor429 = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Exponential backoff — but skip if we already slept for a 429 Retry-After
    if (attempt > 0 && !sleptFor429 && retryDelayMs > 0) {
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
    sleptFor429 = false; // Reset for next iteration

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (clientVersion) {
        headers["X-Pew-Client-Version"] = clientVersion;
      }

      const resp = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });

      if (resp.ok) {
        if (opts.validateResponse) {
          const error = opts.validateResponse(await resp.json().catch(() => null), batch);
          if (error) return { ok: false, error };
        }
        return { ok: true };
      }

      // 429 — rate limited, retry with Retry-After if available
      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After");
        const retryMs = retryAfter
          ? Math.max(Number(retryAfter) * 1000, retryDelayMs)
          : retryDelayMs * 2 ** attempt;
        if (attempt < maxRetries && retryMs > 0) {
          await sleep(retryMs);
          sleptFor429 = true; // Skip the top-of-loop backoff on next iteration
        }
        const body = await resp.json().catch(() => ({}));
        lastError = `429: ${(body as Record<string, string>).error ?? "Too Many Requests"}`;
        continue;
      }

      // 4xx — client error, don't retry
      if (resp.status >= 400 && resp.status < 500) {
        const body = await resp.json().catch(() => ({}));
        const msg =
          (body as Record<string, string>).error ?? `HTTP ${resp.status}`;
        return { ok: false, error: `${resp.status}: ${msg}` };
      }

      // 5xx — server error, retry
      const body = await resp.json().catch(() => ({}));
      lastError = `${resp.status}: ${(body as Record<string, string>).error ?? "Server Error"}`;
    } catch (err) {
      lastError = String((err as Error).message ?? err);

      if (attempt >= maxRetries) {
        return { ok: false, error: lastError };
      }
    }
  }

  return {
    ok: false,
    error: `Upload failed after ${maxRetries + 1} attempts: ${lastError}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
