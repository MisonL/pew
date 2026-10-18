/**
 * POST /api/ingest/sessions — receive session records from CLI and forward to Worker.
 *
 * Authentication: resolveUser (session, Bearer api_key, or E2E bypass).
 * Body: SessionIngestRecord[] array.
 *
 * Validation and handler logic delegated to createIngestHandler factory.
 */

import { validateSessionIngestRecord } from "@pew/core";
import { createIngestHandler, resolveIngestUrl } from "@/lib/ingest-handler";

export const POST = createIngestHandler({
  validateRecord: validateSessionIngestRecord,
  getWorkerUrl: () => resolveIngestUrl("sessions"),
  entityName: "session records",
});
