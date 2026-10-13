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

const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";
const INTERVAL_MS = Number(process.env.DAILY_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
// Read-only rqlite credentials (Plan 3 §3.1.2), same fallback as server-read;
// `||` not `??` because compose injects empty strings when unset.
const RQLITE_USERNAME = process.env.RQLITE_READ_USERNAME || process.env.RQLITE_USERNAME;
const RQLITE_PASSWORD = process.env.RQLITE_READ_PASSWORD || process.env.RQLITE_PASSWORD;
const BASIC_AUTH = RQLITE_USERNAME && RQLITE_PASSWORD
  ? { username: RQLITE_USERNAME, password: RQLITE_PASSWORD }
  : undefined;

const db = createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN, ...(BASIC_AUTH ? { basicAuth: BASIC_AUTH } : {}) });
// Same narrowing as server-read: the adapters cover the worker's actual call
// surface, not the full D1Database/KVNamespace interfaces.
const env = {
  DB: db,
  CACHE: createKvAdapter({ db }),
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
