/**
 * Hosts packages/worker-read on node:http, wired to the rqlite-backed
 * D1 and KV adapters. Serves /api/live (no auth) and /api/rpc (Bearer).
 */

import worker from "../../packages/worker-read/src/index";
import type { Env } from "../../packages/worker-read/src/index";
import { createD1Adapter } from "./d1-adapter";
import { createKvAdapter } from "./kv-adapter";
import { createWorkerServer, registerShutdownSignals, requireSecret } from "./node-runtime";

const PORT = Number(process.env.PORT ?? 8787);
const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";
// Read-only rqlite credentials (Plan 3 §3.1.2): RQLITE_READ_* when set,
// falling back to the full credentials (pew-ro defaults to RQLITE_PASSWORD,
// so the full user works there too). `||` not `??`: compose injects these as
// EMPTY STRINGS when unset, and an empty credential must count as unset.
const RQLITE_USERNAME = process.env.RQLITE_READ_USERNAME || process.env.RQLITE_USERNAME;
const RQLITE_PASSWORD = process.env.RQLITE_READ_PASSWORD || process.env.RQLITE_PASSWORD;
const BASIC_AUTH = RQLITE_USERNAME && RQLITE_PASSWORD
  ? { username: RQLITE_USERNAME, password: RQLITE_PASSWORD }
  : undefined;

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
