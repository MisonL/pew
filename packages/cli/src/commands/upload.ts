/**
 * CLI upload command — sends local token queue records to the pew SaaS.
 *
 * Thin wrapper around the generic upload engine with token-specific
 * preprocessing (aggregation by source/model/hour_start).
 */

import { LocalQueue } from "../storage/local-queue.js";
import { EvidenceQueue } from "../storage/evidence-queue.js";
import { AccountingQueue, accountingKey } from "../storage/accounting-queue.js";
import { recoverSyncCommit } from "../storage/sync-commit.js";
import { withStateLock } from "../storage/state-lock.js";
import { evidenceKey } from "../utils/usage-evidence.js";
import { evidenceRecordRejection, tokenRecordRejection } from "../utils/ingest-contract.js";
import type { OnCorruptLine } from "../storage/base-queue.js";
import { createUploadEngine } from "./upload-engine.js";
import type {
  UploadResult,
  UploadProgressEvent,
} from "./upload-engine.js";
import type { AccountingRecord, EvidenceRecord, QueueRecord } from "@pew/core";

// ---------------------------------------------------------------------------
// Types (re-exported for backward compatibility)
// ---------------------------------------------------------------------------

export interface UploadOptions {
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
  /** CLI version string for server-side version gate */
  clientVersion?: string;
  /** Callback invoked when a corrupted JSONL line is found in the queue */
  onCorruptLine?: OnCorruptLine;
}

// Re-export line removed 2026-07-08 (G1 cleanup): both UploadResult and
// UploadProgressEvent are consumed only via their true source
// `./upload-engine.js`. Restore this line if callers want the shorter path.

// ---------------------------------------------------------------------------
// Pre-aggregation — merge QueueRecords with the same (source, model, hour_start)
// ---------------------------------------------------------------------------

/**
 * Aggregate QueueRecords by (source, model, hour_start), summing token fields.
 *
 * This ensures that when combined with server-side overwrite upsert, the
 * pipeline is fully idempotent: re-scanning and re-uploading produces the
 * same final result in D1.
 */
export function aggregateRecords(records: QueueRecord[]): QueueRecord[] {
  if (records.length === 0) return [];

  const map = new Map<string, QueueRecord>();

  for (const r of records) {
    const key = `${r.source}|${r.model}|${r.hour_start}|${r.device_id}`;
    const existing = map.get(key);
    if (existing) {
      existing.input_tokens += r.input_tokens;
      existing.cached_input_tokens += r.cached_input_tokens;
      existing.output_tokens += r.output_tokens;
      existing.reasoning_output_tokens += r.reasoning_output_tokens;
      existing.total_tokens += r.total_tokens;
    } else {
      map.set(key, { ...r });
    }
  }

  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function executeUpload(opts: UploadOptions): Promise<UploadResult> {
  return withStateLock(opts.stateDir, () => uploadLocked(opts));
}

async function uploadLocked(opts: UploadOptions): Promise<UploadResult> {
  // Recovery can discard a snapshot a newer scan disagreed with (see
  // EvidenceQueue.merge). That is not a failure, but it is the only moment
  // the operator can learn about it, so carry it into the stage warnings.
  const recoveryWarnings: string[] = [];
  await recoverSyncCommit(opts.stateDir, (message) => recoveryWarnings.push(message));
  const queue = new LocalQueue(opts.stateDir, opts.onCorruptLine);

  const engine = createUploadEngine<QueueRecord>({
    queue,
    endpoint: "/api/ingest",
    entityName: "records",
    preprocess: aggregateRecords,
    recordKey: (r) => `${r.source}|${r.model}|${r.hour_start}|${r.device_id}`,
    rejectRecord: tokenRecordRejection,
    trackUploadTarget: true,
  });

  const main = await engine.execute(opts);
  if (!main.success) return main;
  // Keep each stage's own warning when merging: the spread below takes the
  // supplemental result, which has no idea a re-route happened, and the
  // evidence stage's "skipped/refused" line exists only on its own result.
  const warnings = [main.warning, ...recoveryWarnings];
  const supplemental = await createUploadEngine<EvidenceRecord>({
    queue: new EvidenceQueue(opts.stateDir), endpoint: "/api/ingest/evidence",
    entityName: "usage evidence", preprocess: (records) => records,
    recordKey: evidenceKey, rejectRecord: evidenceRecordRejection,
  }).execute(opts);
  // The token stage is the only one that records the target, so it is also the
  // one that notices a switch — but it says nothing when its own queue is
  // empty, while the evidence/accounting backlogs behind it still ship to the
  // new host. Report the switch when any stage actually sends to a different
  // origin than the last recorded drain.
  const usage = { ...supplemental, uploaded: main.uploaded + supplemental.uploaded, batches: main.batches + supplemental.batches };
  warnings.push(supplemental.warning);
  // A failure here is an evidence-stage failure, but the caller only sees one
  // combined result. Prefix the message with its stage: an old server that
  // answers 404 for /api/ingest/evidence otherwise prints "Token upload
  // failed" while the token stage succeeded, sending the operator after the
  // wrong queue.
  if (!supplemental.success) {
    return { ...usage, error: `usage evidence: ${supplemental.error}`, ...mergeWarnings(warnings) };
  }
  const details = await createUploadEngine<AccountingRecord>({
    queue: new AccountingQueue(opts.stateDir), endpoint: "/api/ingest/details", entityName: "accounting details",
    preprocess: (records) => records, recordKey: accountingKey, maxBatchSize: 25, maxBatchBytes: 600_000,
    validateResponse: (body, batch) => {
      const value = body as { details_version?: unknown; acknowledgments?: unknown } | null;
      if (value?.details_version !== 1 || !Array.isArray(value.acknowledgments) || value.acknowledgments.length !== batch.length) return "Server did not acknowledge accounting details v1";
      const refused: string[] = [];
      for (let i = 0; i < batch.length; i++) {
        const ack = value.acknowledgments[i]; const r = batch[i];
        if (!ack || ack.key !== accountingKey(r) || ack.source_revision !== r.source_revision || ack.parser_revision !== r.parser_revision ||
          ack.detail_revision !== r.detail_revision) return "Accounting details need reconciliation or a compatible server";
        // `base_mismatch`/`conflict` are permanent for this snapshot: the
        // server has no token base for the bucket or a newer stored revision
        // disagrees. Retrying cannot change that answer, so the record stays
        // pending without blocking the annotations queued behind it.
        if (ack.status === "base_mismatch" || ack.status === "conflict") refused.push(accountingKey(r));
        else if (!["applied", "duplicate", "superseded"].includes(ack.status)) return "Accounting details need reconciliation or a compatible server";
      }
      return refused.length > 0 ? { keys: refused, reason: "the server has no matching token base or a newer stored revision" } : null;
    },
  }).execute(opts);
  if (!details.success) warnings.push(`Accounting details pending: ${details.error}`);
  // A refused record is not a stage failure: the engine keeps it pending and
  // warns. `usage` was spread from the supplemental result, so the details
  // stage's warning has to be carried into the merge explicitly.
  else warnings.push(details.warning);
  // The token stage is the only one that records the target, so it is also the
  // one that detects a switch — but it stays silent when its own queue is
  // empty, while the evidence/accounting backlogs behind it still ship to the
  // new host. Warn whenever any stage actually shipped to a different origin
  // than the last recorded drain.
  if (main.targetChangedFrom && !main.warning &&
      (main.uploaded > 0 || supplemental.uploaded > 0 || details.uploaded > 0)) {
    warnings.push(`Last successful upload went to ${main.targetChangedFrom}; this run sent pending records to ${opts.apiUrl}.`);
  }
  return { ...usage, uploaded: usage.uploaded + details.uploaded, batches: usage.batches + details.batches,
    ...mergeWarnings(warnings) };
}

function mergeWarnings(warnings: Array<string | undefined>): { warning?: string } {
  const present = warnings.filter((w): w is string => Boolean(w));
  return present.length > 0 ? { warning: present.join(" ") } : {};
}
