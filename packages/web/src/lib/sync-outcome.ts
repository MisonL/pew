/**
 * What the admin "Refresh prices" button should say about one rebuild response.
 *
 * The rebuild route answers 200 for `ok`, 207 for a partial failure and 502
 * when the RPC threw — but `ok` alone is not "prices changed": a run that
 * started before a newer published result deliberately writes nothing
 * (`skippedReason`) while still having no errors. Reporting that as
 * "Prices updated" told the operator a refresh had landed when the catalogue
 * was untouched.
 */
export type SyncOutcomeView =
  | { kind: "ok" }
  | { kind: "partial" }
  | { kind: "skipped"; reason: string }
  | { kind: "error" };

type RebuildBody = { ok?: unknown; skippedReason?: unknown } | null;

export function describeSyncOutcome(status: number, body: RebuildBody): SyncOutcomeView {
  if (status !== 200 && status !== 207) return { kind: "error" };
  const skipped = typeof body?.skippedReason === "string" && body.skippedReason.length > 0
    ? body.skippedReason
    : null;
  if (skipped !== null) return { kind: "skipped", reason: skipped };
  return status === 200 ? { kind: "ok" } : { kind: "partial" };
}
