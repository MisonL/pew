/**
 * Hosts packages/worker (the ingest worker) on node:http. This worker has no
 * scheduled handler, so only fetch is wired up.
 */

import worker from "../../packages/worker/src/index";
import type { Env } from "../../packages/worker/src/index";
import { createD1Adapter } from "./d1-adapter";
import { createWorkerServer, registerShutdownSignals, requireSecret } from "./node-runtime";
import { resolveEnvBasicAuth } from "./basic-auth";

const PORT = Number(process.env.PORT ?? 8786);
const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const D1_TOKEN = process.env.CF_D1_API_TOKEN ?? "";
// Full rqlite credentials (Plan 3 §3.1.2); empty or unset means no auth.
const BASIC_AUTH = resolveEnvBasicAuth();

// The adapter implements the D1 methods the worker actually calls, not the
// full D1Database interface; narrow through `unknown` at this wiring point.
const env = {
  DB: createD1Adapter({ baseUrl: RQLITE_URL, token: D1_TOKEN, ...(BASIC_AUTH ? { basicAuth: BASIC_AUTH } : {}) }),
  WORKER_SECRET: requireSecret("WORKER_SECRET", process.env.WORKER_SECRET ?? ""),
} as unknown as Env;

createWorkerServer({
  // worker.fetch is optional per its Cloudflare type but always defined here.
  worker: worker as { fetch: (request: Request, env: Env) => Promise<Response> },
  env,
  port: PORT,
})
  .listen()
  .then((handle) => {
    console.log(`worker-ingest listening on :${handle.port}`);
    registerShutdownSignals(handle.close);
  })
  .catch((error: unknown) => {
    console.error("failed to start worker-ingest", error);
    process.exit(1);
  });
