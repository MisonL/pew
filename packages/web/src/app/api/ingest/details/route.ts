import { accountingAcknowledgment, retiredAccountingAcknowledgment, validateAccountingRecord, MAX_ACCOUNTING_BODY_BYTES, MAX_ACCOUNTING_BATCH_SIZE } from "@pew/core";
import { createIngestHandler, resolveIngestUrl } from "@/lib/ingest-handler";

export const POST = createIngestHandler({
  validateRecord: validateAccountingRecord,
  getWorkerUrl: () => resolveIngestUrl("details"),
  entityName: "accounting details",
  maxBodyBytes: MAX_ACCOUNTING_BODY_BYTES,
  maxBatchSize: MAX_ACCOUNTING_BATCH_SIZE,
  acknowledgment: accountingAcknowledgment,
  retiredAcknowledgment: retiredAccountingAcknowledgment,
});
