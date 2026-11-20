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
import type { RefusedRecords } from "./upload-engine.js";

// ---------------------------------------------------------------------------
// Record identity and revoked-device receipt
// ---------------------------------------------------------------------------

/** Token records are one bucket per (source, model, hour, device). */
function tokenKey(r: QueueRecord): string {
  return `${r.source}|${r.model}|${r.hour_start}|${r.device_id}`;
}

/**
 * The ingest Worker answers revoked-device records with `dropped_devices`
 * (device ids whose rows the revocation guard discarded). Those records were
 * not applied, so they stay pending here; the token/evidence queues keep a
 * per-record pending set, so the engine can clear exactly them. Records whose
 * device the server did not revoke are left alone, so a whole-batch retry
 * never re-revokes healthy data.
 */
function droppedDevicesRefusal<T extends { device_id?: string }>(
  body: unknown,
  batch: T[],
  keyOf: (record: T) => string,
  entityName: string,
): string | RefusedRecords | null {
  const value = body as { dropped_devices?: unknown } | null;
  if (!Array.isArray(value?.dropped_devices)) return null;
  const droppedSet = new Set(value.dropped_devices as string[]);
  const keys = batch
    .filter((r) => r.device_id !== undefined && droppedSet.has(r.device_id as string))
    .map(keyOf);
  if (keys.length === 0) return null;
  // The refusal is permanent while the device stays revoked, so the warning
  // carries the two exits: restore the device and the pending set retries on
  // the next sync, or run `pew reset && pew sync` once it is gone for good.
  // Every one of these keys is a revoked-device record, so the engine may
  // discard exactly this subset when the user asked for it.
  return { keys, revokedKeys: keys, reason: `the server revoked device(s) ${[...droppedSet].join(", ")} and ignored their ${entityName}; restore the device to retry` };
}

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
  /**
   * Discard queued records the server refused as revoked-device records
   * instead of keeping them pending (`pew sync --drop-revoked`).
   */
  dropRevoked?: boolean;
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
    recordKey: tokenKey,
    rejectRecord: tokenRecordRejection,
    trackUploadTarget: true,
    discardRevoked: opts.dropRevoked,
    validateResponse: (body, batch) => droppedDevicesRefusal(body, batch, tokenKey, "usage records"),
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
    discardRevoked: opts.dropRevoked,
    validateResponse: (body, batch) => droppedDevicesRefusal(body, batch, evidenceKey, "usage evidence"),
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
    discardRevoked: opts.dropRevoked,
    // 600 KB is a network-timeout guard, not the server's ceiling: an
    // AccountingRecord may carry 256 groups × 4 reported costs, and one that
    // validates can measure ~617 KB. The engine skips a record over this limit
    // and keeps it pending, so the rest of the outbox still ships; 24 MB is
    // MAX_ACCOUNTING_BODY_BYTES (@pew/core, not a CLI runtime dependency).
    maxRecordBytes: 24 * 1024 * 1024,
    validateResponse: (body, batch) => {
      const value = body as { details_version?: unknown; acknowledgments?: unknown } | null;
      if (value?.details_version !== 1 || !Array.isArray(value.acknowledgments) || value.acknowledgments.length !== batch.length) return "Server did not acknowledge accounting details v1";
      const refused: string[] = [];
      const revoked: string[] = [];
      const reasons = new Set<string>();
      for (let i = 0; i < batch.length; i++) {
        const ack = value.acknowledgments[i]; const r = batch[i];
        if (!ack || ack.key !== accountingKey(r) || ack.source_revision !== r.source_revision || ack.parser_revision !== r.parser_revision ||
          ack.detail_revision !== r.detail_revision) return "Accounting details need reconciliation or a compatible server";
        // `base_mismatch`/`conflict` are permanent for this snapshot: the
        // server has no token base for the bucket or a newer stored revision
        // disagrees. Retrying cannot change that answer, so the record stays
        // pending without blocking the annotations queued behind it.
        // `device_revoked` is the same shape: the trigger discarded the row
        // and the answer only changes if the device is un-revoked, so the
        // annotation keeps its pending key instead of being cleared.
        if (ack.status === "base_mismatch" || ack.status === "conflict") {
          refused.push(accountingKey(r));
          reasons.add("the server has no matching token base or a newer stored revision");
        } else if (ack.status === "device_revoked") {
          refused.push(accountingKey(r));
          revoked.push(accountingKey(r));
          reasons.add("the revoked device's details were discarded; the annotation stays pending until the device is restored unless --drop-revoked was passed");
        } else if (!["applied", "duplicate", "superseded"].includes(ack.status)) return "Accounting details need reconciliation or a compatible server";
      }
      return refused.length > 0 ? { keys: refused, revokedKeys: revoked, reason: [...reasons].join("; ") } : null;
    },
  }).execute(opts);
  if (!details.success) warnings.push(`Accounting details pending: ${details.error}`);
  // A refused record is not a stage failure: the engine keeps it pending and
  // warns. `usage` was spread from the supplemental result, so the details
  // stage's warning has to be carried into the merge explicitly.
  else warnings.push(details.warning);
  // The token stage is the only one that records the target, so it is also the
  // one that detects a switch — but it only says so on its success path. A
  // stage that rejected every record ships nothing yet still comes back
  // "successful" with its own warning, and testing `!main.warning` there
  // suppressed the notice even though the evidence/accounting backlogs behind
  // it went to the new host. Dedupe on the sentence the engine actually emitted
  // instead of on "the token stage produced any warning at all".
  const engineReportedSwitch = main.warning?.includes("Last successful upload went to") ?? false;
  if (main.targetChangedFrom && !engineReportedSwitch &&
      (main.uploaded > 0 || supplemental.uploaded > 0 || details.uploaded > 0)) {
    warnings.push(`Last successful upload went to ${main.targetChangedFrom}; this run sent pending records to ${opts.apiUrl}.`);
  }
  // A refusal (a revoked device, an accounting base mismatch) keeps the record
  // pending and warns, but the caller only receives this merged result — each
  // stage's own `refused` count has to be carried across or the operator's
  // summary says everything was accepted.
  const refused = (main.refused ?? 0) + (supplemental.refused ?? 0) + (details.refused ?? 0);
  const discarded = (main.discarded ?? 0) + (supplemental.discarded ?? 0) + (details.discarded ?? 0);
  return { ...usage, uploaded: usage.uploaded + details.uploaded, batches: usage.batches + details.batches,
    ...(refused > 0 ? { refused } : {}),
    ...(discarded > 0 ? { discarded } : {}),
    ...mergeWarnings(warnings) };
}

function mergeWarnings(warnings: Array<string | undefined>): { warning?: string } {
  const present = warnings.filter((w): w is string => Boolean(w));
  return present.length > 0 ? { warning: present.join(" ") } : {};
}
