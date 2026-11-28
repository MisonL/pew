/**
 * Compose the message shown after a season PATCH.
 *
 * The route commits the update and only reports a failed roster backfill as a
 * `warning` on the 200 body ("run Sync Rosters to retry"). The edit form used
 * to read only `error` and unconditionally report success, so the warning was
 * invisible and the admin never learned the seats were not refilled.
 */
export function seasonUpdatedMessage(
  name: string,
  warning: unknown,
): { type: "success" | "warning"; text: string } {
  const base = `Season "${name}" updated.`;
  return typeof warning === "string" && warning.length > 0
    ? { type: "warning", text: `${base} ${warning}` }
    : { type: "success", text: base };
}
