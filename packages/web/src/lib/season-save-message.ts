/**
 * Compose the message shown after a season POST/PATCH.
 *
 * Both routes commit the season and report a failed side effect — a roster
 * backfill on PATCH, best-effort auto-registration on POST — as a `warning`
 * on the 200/201 body. The forms used to read only `error` and unconditionally
 * report success, so the warning was invisible and the admin never learned
 * the seats or teams were not filled.
 */
function seasonMessage(
  base: string,
  warning: unknown,
): { type: "success" | "warning"; text: string } {
  return typeof warning === "string" && warning.length > 0
    ? { type: "warning", text: `${base} ${warning}` }
    : { type: "success", text: base };
}

export function seasonUpdatedMessage(
  name: string,
  warning: unknown,
): { type: "success" | "warning"; text: string } {
  return seasonMessage(`Season "${name}" updated.`, warning);
}

export function seasonCreatedMessage(
  name: string,
  warning: unknown,
): { type: "success" | "warning"; text: string } {
  return seasonMessage(`Season "${name}" created.`, warning);
}
