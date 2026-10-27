/**
 * Hosts a Cloudflare Worker's `export default { fetch, scheduled }` on
 * node:http. Both pew workers expose a standard Request -> Response fetch
 * handler, and Node 22 implements those Web types natively, so no Worker
 * runtime emulation is needed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface WorkerLike {
  fetch(request: Request, env: never): Promise<Response>;
  scheduled?: (event: unknown, env: never) => Promise<void>;
}

export interface WorkerServerOptions<E> {
  worker: { fetch(request: Request, env: E): Promise<Response> };
  env: E;
  port: number;
  hostname?: string;
  /** Override for tests; production keeps the Cloudflare-derived default. */
  maxBodyBytes?: number;
}

export interface WorkerServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Cloudflare caps request bodies at 100MB; keep headroom below that. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Distinguishes "too large" from a genuine server fault so the handler can
 * answer 413 (final) instead of 500 (which clients retry forever). The
 * d1-http container already answers 413 for the same condition.
 */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function toRequest(req: IncomingMessage, body: Buffer | undefined): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`).toString();
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  // Buffer is a Uint8Array at runtime but does not structurally satisfy
  // BodyInit's DOM lib type; hand over an ArrayBuffer-backed view instead.
  // GET/HEAD have no body regardless of what readBody returned.
  const bodyInit: RequestInit["body"] =
    body && method !== "GET" && method !== "HEAD" ? new Uint8Array(body).buffer : undefined;
  return new Request(url, { method, headers, body: bodyInit });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  // appendHeader, not setHeader: Headers.forEach yields each Set-Cookie as its
  // own entry, and setHeader would overwrite all but the last. The workers
  // return JSON only today, but this keeps the host faithful to fetch().
  response.headers.forEach((value, name) => {
    res.appendHeader(name, value);
  });
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export function createWorkerServer<E>(options: WorkerServerOptions<E>) {
  return {
    async listen(): Promise<WorkerServerHandle> {
      const server = createServer((req, res) => {
        void (async () => {
          try {
            const body = await readBody(req, options.maxBodyBytes ?? MAX_BODY_BYTES);
            const response = await options.worker.fetch(toRequest(req, body), options.env);
            await sendResponse(res, response);
          } catch (error) {
            console.error("worker request failed", error);
            // An aborted readBody leaves unread request bytes in flight; under
            // keep-alive Node would parse that remainder as the next request
            // (same trap server-d1-http.ts fixes with its 413 path). Tear the
            // connection down after responding instead of reusing it.
            const tooLarge = error instanceof BodyTooLargeError;
            if (!res.headersSent) {
              res.statusCode = tooLarge ? 413 : 500;
              res.setHeader("Connection", "close");
            }
            res.end(
              JSON.stringify({ error: tooLarge ? "Request body too large" : "Internal server error" }),
              () => req.destroy(),
            );
          }
        })();
      });

      // Port collision raises a (port, error) callback, so listen can reject
      // here. Port collisions are the most common runtime failure.
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.hostname ?? "0.0.0.0", resolve);
      });

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;

      return {
        port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            // closeIdleConnections first: keep-alive sockets that are not
            // serving a request would otherwise keep close() pending.
            server.closeIdleConnections();
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      };
    },
  };
}

/**
 * Drives `scheduled` on a fixed interval, standing in for Cloudflare cron
 * triggers. Run this in exactly one container so replicas do not all sync.
 */
export interface ScheduledHandle {
  stop: () => void;
  /** Resolves when the currently running tick (if any) finishes. */
  drain: () => Promise<void>;
}

export function runScheduled<E>(
  worker: { scheduled?: (event: unknown, env: E) => Promise<void> },
  env: E,
  intervalMs: number
): ScheduledHandle {
  if (!worker.scheduled) {
    // Workers without scheduled (worker) still get a usable handle.
    return { stop: () => { /* nothing to stop */ }, drain: async () => { /* nothing to drain */ } };
  }
  const handler = worker.scheduled.bind(worker);
  // Track every in-flight tick so shutdown can wait for all of them: a run
  // that outlasts the interval overlaps the next tick, and a single "latest
  // promise" reference let drain() resolve while older runs were still
  // writing D1/KV. A pricing sync killed between its D1 and KV writes would
  // leave the cache half-updated.
  const inFlight = new Set<Promise<void>>();
  const track = (run: Promise<void>): void => {
    inFlight.add(run);
    void run.finally(() => {
      inFlight.delete(run);
    });
  };
  const tick = (): void => {
    // try/catch around the CALL, not just .catch on the returned promise: the
    // handler body runs synchronously up to its first await, so a throw there
    // would escape and — for the startup run below — crash the process before
    // any timer is armed. setInterval has the same hazard for every later tick.
    try {
      track(
        Promise.resolve(handler({ scheduledTime: Date.now() }, env)).catch((error: unknown) => {
          console.error("scheduled run failed", error);
        })
      );
    } catch (error) {
      console.error("scheduled run failed", error);
    }
  };
  // Run once at startup: setInterval fires only after a full period, so with
  // the production 24h DAILY_INTERVAL_MS the first pricing sync and kv_cache
  // sweep would land a day after every restart — and a container recreated
  // more often than the interval would never run them at all (verified on the
  // live deployment: hours of uptime, zero ticks, expired cache rows left).
  // The upstream Cloudflare deployment does not have this gap: its cron
  // expression fires at wall-clock time regardless of deploy time.
  tick();
  const timer = setInterval(tick, intervalMs);
  // Deliberately NOT unref'd: the scheduler container's only work is this
  // timer, and an unref'd timer does not hold the event loop — a Node process
  // whose only handle is unref'd exits immediately with code 0 before the
  // first tick (verified), so pricing sync would silently never run. The
  // stop() function is the way to release the loop.
  return {
    stop: () => clearInterval(timer),
    drain: async () => {
      await Promise.allSettled([...inFlight]);
    },
  };
}

/**
 * Register SIGTERM/SIGINT handlers so the server closes gracefully when
 * docker compose stops the container. Without this, the default Node behavior
 * is to terminate immediately, dropping in-flight requests.
 *
 * A hard timeout guards against a wedged close (e.g. a keep-alive connection
 * that never ends): after 10s we exit regardless.
 */
export function registerShutdownSignals(close: () => Promise<void>): void {
  // A second signal (SIGTERM then SIGINT from a hurried operator, or a
  // supervisor escalation) must not start a second shutdown: the first
  // close() may already have released the server, and re-running it would
  // reject with ERR_SERVER_NOT_RUNNING and exit 1 — racing the success exit.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      console.log(`received ${signal} while already shutting down; ignoring`);
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down gracefully`);
    // Hard timeout guards against a wedged close (e.g. keep-alive never ends).
    // The timer is deliberately NOT unref()'d: a suspended drain that holds no
    // other live handles (e.g. awaiting a promise with no timer/socket behind
    // it) would otherwise empty the event loop and exit 0 — a silent scheduler
    // death with a "success" code, before the forced exit could fire. Keeping
    // it referenced holds the loop open, and close() returning normally exits
    // via process.exit(0) regardless.
    setTimeout(() => {
      console.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 10_000);
    close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        // A failed drain (port still bound, in-flight write lost) must not
        // report success to the supervisor: restart policies key off the
        // exit code. process.exit is immediate, so the success path above
        // cannot run after this.
        console.error("shutdown error", error);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Fails fast when a required secret is missing OR left at a well-known
 * placeholder. A bare non-empty check would let a published default through,
 * leaving every service authenticated by a value that is public in this repo —
 * the one default an operator is most likely to forget. The set matches
 * requireAuthSecret in packages/web/src/auth.ts so both runtimes reject the
 * same values.
 */
export const SECRET_PLACEHOLDERS = new Set(["", "replace-me", "changeme", "secret"]);

export function requireSecret(name: string, value: string): string {
  if (SECRET_PLACEHOLDERS.has(value)) {
    console.error(
      `${name} is required and must not be empty or a well-known placeholder (replace-me / changeme / secret)`
    );
    process.exit(1);
  }
  return value;
}
