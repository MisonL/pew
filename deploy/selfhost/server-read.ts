/**
 * Hosts packages/worker-read on node:http, wired to the rqlite-backed
 * D1 and KV adapters. Serves /api/live (no auth) and /api/rpc (Bearer).
 */

import worker from "../../packages/worker-read/src/index";
import type { Env } from "../../packages/worker-read/src/index";
import { createD1Adapter } from "./d1-adapter";
import { createKvAdapter } from "./kv-adapter";
import { createWorkerServer, registerShutdownSignals, requireSecret } from "./node-runtime";
import { resolveReadBasicAuth } from "./basic-auth";

const PORT = Number(process.env.PORT ?? 8787);
const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";
// Read-only credentials (Plan 3 §3.1.2): the READ_* pair when set, falling
// back to the full pair as a unit. NOTE: there is deliberately no pew-ro user
// (rqlite 10.5.3 has no "select" permission name and read/scheduler carry
// /db/request write paths, so a read-only user is unreachable here) — the
// READ_* vars are deprecated and this effectively always uses the full user.
const BASIC_AUTH = resolveReadBasicAuth(
  process.env.RQLITE_READ_USERNAME,
  process.env.RQLITE_READ_PASSWORD,
  process.env.RQLITE_USERNAME,
  process.env.RQLITE_PASSWORD
);

const db = createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN, ...(BASIC_AUTH ? { basicAuth: BASIC_AUTH } : {}) });
// The adapters implement the D1/KV methods the workers actually call, not the
// full D1Database/KVNamespace interfaces (exec/withSession/dump/getWithMetadata
// are unused upstream). Narrow through `unknown` at this single wiring point
// rather than widening the adapters with unused stubs.
const env = {
  DB: db,
  CACHE: createKvAdapter({ db }),
  WORKER_READ_SECRET: requireSecret("WORKER_READ_SECRET", process.env.WORKER_READ_SECRET ?? ""),
} as unknown as Env;

createWorkerServer({
  // worker.fetch is optional per its Cloudflare type but always defined here.
  worker: worker as { fetch: (request: Request, env: Env) => Promise<Response> },
  env,
  port: PORT,
})
  .listen()
  .then((handle) => {
    console.log(`worker-read listening on :${handle.port}`);
    registerShutdownSignals(handle.close);
  })
  .catch((error: unknown) => {
    console.error("failed to start worker-read", error);
    process.exit(1);
  });
