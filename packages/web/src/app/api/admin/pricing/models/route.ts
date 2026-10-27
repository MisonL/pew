/**
 * GET /api/admin/pricing/models — admin-only view of dynamic pricing entries.
 *
 * Kept as a backwards-compatible alias of the now-public /api/pricing/models
 * route; both share the same handler. Strictly read-only.
 */

import { resolveAdmin } from "@/lib/admin";
import { forbiddenResponse } from "@/lib/api-responses";
import { fetchDynamicPricingPayload } from "@/lib/pricing-models-handler";

export async function GET(request: Request) {
  // resolveAdmin, not resolveUser + isAdminUser: every admin/* route must
  // share the one session-only admin gate (bearer api_keys are refused).
  const admin = await resolveAdmin(request);
  if (!admin) {
    return forbiddenResponse();
  }

  return fetchDynamicPricingPayload(request);
}
