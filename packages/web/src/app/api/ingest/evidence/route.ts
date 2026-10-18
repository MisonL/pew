import { validateEvidenceRecord } from "@pew/core";
import { createIngestHandler, resolveIngestUrl } from "@/lib/ingest-handler";

export const POST = createIngestHandler({
  validateRecord: validateEvidenceRecord,
  getWorkerUrl: () => resolveIngestUrl("evidence"),
  entityName: "usage evidence",
});
