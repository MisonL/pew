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

const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";
// Number("") is 0 and Number("abc") is NaN; setInterval treats both as a ~1ms
// tick, which would hammer rqlite in a tight loop. Fall back to 24h instead.
const RAW_INTERVAL = Number(process.env.DAILY_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
const INTERVAL_MS = Number.isFinite(RAW_INTERVAL) && RAW_INTERVAL > 0 ? RAW_INTERVAL : 24 * 60 * 60 * 1000;
if (INTERVAL_MS !== RAW_INTERVAL) {
  console.error(`invalid DAILY_INTERVAL_MS "${process.env.DAILY_INTERVAL_MS}", falling back to 24h`);
}
// Read-only rqlite credentials (Plan 3 §3.1.2), same fallback as server-read.
const BASIC_AUTH = resolveReadBasicAuth(
  process.env.RQLITE_READ_USERNAME,
  process.env.RQLITE_READ_PASSWORD,
  process.env.RQLITE_USERNAME,
  process.env.RQLITE_PASSWORD
);

const db = createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN, ...(BASIC_AUTH ? { basicAuth: BASIC_AUTH } : {}) });
// Same narrowing as server-read: the adapters cover the worker's actual call
// surface, not the full D1Database/KVNamespace interfaces.
const env = {
  DB: db,
  CACHE: createKvAdapter({ db }),
  // Not requireSecret: the scheduler only calls scheduled(), which syncs
  // pricing outbound and never serves requests, so the read secret gate
  // (worker-read's /api/rpc Bearer check) is not on its path.
  WORKER_READ_SECRET: process.env.WORKER_READ_SECRET ?? "",
} as unknown as Env;

console.log(`scheduler running every ${INTERVAL_MS}ms`);
// The worker's `scheduled` may be undefined per its Cloudflare type; this
// worker defines it, so assert the concrete shape node-runtime expects.
const stop = runScheduled({ scheduled: worker.scheduled } as {
  scheduled: (event: unknown, env: Env) => Promise<void>;
}, env, INTERVAL_MS);
registerShutdownSignals(async () => {
  stop();
});
