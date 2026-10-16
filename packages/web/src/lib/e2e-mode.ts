/**
 * The E2E auth-bypass gate — single definition.
 *
 * The bypass is only ever legitimate inside the test runner's isolated
 * environment (scripts/local-e2e-bindings.ts), which sets RESOURCE_ENV=test
 * alongside E2E_SKIP_AUTH=true. Keying on RESOURCE_ENV (not NODE_ENV) is what
 * lets the L3 browser lane run against a production build.
 *
 * RAILWAY_ENVIRONMENT is an independent veto: a deployed environment never
 * legitimately carries the bypass, so the gate is fail-closed there even if
 * the two other variables are misconfigured.
 *
 * Every consumer (API auth, admin bypass, invite gate, page proxy) must call
 * this one function — three hand-rolled copies had already drifted once.
 */
export function isE2EMode(env: Record<string, string | undefined> = process.env): boolean {
  return (
    env.E2E_SKIP_AUTH === "true" &&
    env.RESOURCE_ENV === "test" &&
    !env.RAILWAY_ENVIRONMENT
  );
}
