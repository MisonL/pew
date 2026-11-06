/**
 * Runs worker-read's scheduled handler (dynamic pricing sync) on a timer.
 *
 * Kept as its own container and scaled to exactly one replica: if every read
 * replica ran the timer they would all sync concurrently.
 *
 * DAILY_INTERVAL_MS defaults to 24h, matching the upstream Cloudflare cron
 * "0 3 * * *".
 */

import worker from "../../packages/worker-read/src/index";
import type { Env } from "../../packages/worker-read/src/index";
import { createD1Adapter } from "./d1-adapter";
import { createKvAdapter } from "./kv-adapter";
import { registerShutdownSignals, runScheduled } from "./node-runtime";
import { resolveReadBasicAuth } from "./basic-auth";
import { createSingleFlight, resolveDailyIntervalMs } from "./scheduler-guard";

const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";
// A value outside [1, 2^31-1] ms is not merely weird: setInterval stores the
// delay in a 32-bit signed integer and silently substitutes 1 ms for anything
// larger (verified on Bun 1.4.4), so a "monthly" 2592000000 would turn the
// daily pricing sync into a millisecond loop against rqlite and two upstream
// APIs. Anything invalid falls back to 24h.
const { intervalMs: INTERVAL_MS, error: intervalError } = resolveDailyIntervalMs(process.env.DAILY_INTERVAL_MS);
if (intervalError) console.error(intervalError);
// Read-only rqlite credentials (Plan 3 §3.1.2), same fallback as server-read.
const BASIC_AUTH = resolveReadBasicAuth(
  process.env.RQLITE_READ_USERNAME,
  process.env.RQLITE_READ_PASSWORD,
  process.env.RQLITE_USERNAME,
  process.env.RQLITE_PASSWORD
);

const db = createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN, ...(BASIC_AUTH ? { basicAuth: BASIC_AUTH } : {}) });
// The KV adapter keeps expired rows (Cloudflare KV expires them itself), and
// leaderboard snapshot keys embed the revision — without a sweep the table
// grows forever. Piggy-back the sweep on the daily tick.
const kv = createKvAdapter({ db });
// Same narrowing as server-read: the adapters cover the worker's actual call
// surface, not the full D1Database/KVNamespace interfaces.
const env = {
  DB: db,
  CACHE: kv,
  // Not requireSecret: the scheduler only calls scheduled(), which syncs
  // pricing outbound and never serves requests, so the read secret gate
  // (worker-read's /api/rpc Bearer check) is not on its path.
  WORKER_READ_SECRET: process.env.WORKER_READ_SECRET ?? "",
} as unknown as Env;

console.log(`scheduler running every ${INTERVAL_MS}ms`);
// The worker's `scheduled` may be undefined per its Cloudflare type; this
// worker defines it, so assert the concrete shape node-runtime expects.
//
// Single-flight: the timer fires on its own schedule, so a run that outlasts
// the interval would start a second pricing sync on top of the first. Both
// read `pricing:dynamic`, merge independently and write it back, so whichever
// finishes last can drop entries the other just fetched. A skipped tick is
// logged once and resolves with the in-flight run, which is also what
// shutdown draining waits for.
const flight = createSingleFlight(() => console.warn("skipping a scheduled run: the previous one is still in flight"));

const scheduled = runScheduled({
  scheduled: async (event, scheduledEnv) => {
    await flight.trigger(async () => {
      // Cloudflare KV expires rows itself; rqlite keeps them forever, and
      // leaderboard snapshot keys embed the revision — unswept, the table grows
      // without bound. A sweep failure must not skip the pricing sync.
      try {
        const removed = await kv.sweepExpired();
        if (removed > 0) console.log(`kv_cache sweep removed ${removed} expired rows`);
      } catch (error) {
        console.error("kv_cache sweep failed", error);
      }
      await worker.scheduled?.(event, scheduledEnv);
    });
  },
}, env, INTERVAL_MS);

registerShutdownSignals(async () => {
  scheduled.stop();
  // Let an in-flight sync finish: it writes D1 and KV in sequence, and a
  // process.exit mid-run would leave the cache half-updated. The 10s forced
  // timeout in registerShutdownSignals still bounds a wedged run.
  await scheduled.drain();
});
