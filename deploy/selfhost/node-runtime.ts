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
}

export interface WorkerServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Cloudflare caps request bodies at 100MB; keep headroom below that. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
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
            const body = await readBody(req);
            const response = await options.worker.fetch(toRequest(req, body), options.env);
            await sendResponse(res, response);
          } catch (error) {
            console.error("worker request failed", error);
            if (!res.headersSent) res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal server error" }));
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
export function runScheduled<E>(
  worker: { scheduled?: (event: unknown, env: E) => Promise<void> },
  env: E,
  intervalMs: number
): () => void {
  if (!worker.scheduled) {
    // Workers without scheduled (worker) still get a usable stop function.
    return () => {
      /* nothing to stop */
    };
  }
  const handler = worker.scheduled.bind(worker);
  const timer = setInterval(() => {
    void handler({ scheduledTime: Date.now() }, env).catch((error: unknown) => {
      console.error("scheduled run failed", error);
    });
  }, intervalMs);
  // Deliberately NOT unref'd: the scheduler container's only work is this
  // timer, and an unref'd timer does not hold the event loop — a Node process
  // whose only handle is unref'd exits immediately with code 0 before the
  // first tick (verified), so pricing sync would silently never run. The
  // stop() function is the way to release the loop.
  return () => clearInterval(timer);
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
  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, shutting down gracefully`);
    const forced = setTimeout(() => {
      console.error("graceful shutdown timed out; forcing exit");
      process.exit(0);
    }, 10_000);
    forced.unref();
    close()
      .catch((error: unknown) => console.error("shutdown error", error))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Fails fast when a required secret is missing OR left at the `.env.example`
 * placeholder. A bare non-empty check would let the quickstart's `replace-me`
 * through, leaving every service authenticated by a value that is published
 * in this repo — the one default an operator is most likely to forget.
 */
export function requireSecret(name: string, value: string): string {
  if (!value || value === "replace-me") {
    console.error(`${name} is required and must not be the placeholder "replace-me"`);
    process.exit(1);
  }
  return value;
}
