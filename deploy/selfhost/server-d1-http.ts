/**
 * Entry point for the d1-http container.
 *
 * Serves the D1 REST shape on PORT (default 8788). Only the web container
 * needs to reach it; it is never published to the host.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolveEnvBasicAuth, toAuthorizationHeader, type BasicAuth } from "./basic-auth";
import { createD1HttpServer } from "./d1-http";
import { registerShutdownSignals, requireSecret } from "./node-runtime";

/** A d1-http request is a single SQL batch; 8MB is far beyond any real query. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface D1HttpNodeHandlerOptions {
  d1: { handle(request: Request): Promise<Response> };
  rqliteUrl: string;
  basicAuth?: BasicAuth;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/**
 * The node:http request handler for the d1-http container, exported so tests
 * can drive the real transport behavior (413 body limit, header propagation,
 * credentialed /health probe) over actual sockets.
 */
export function createD1HttpNodeHandler(options: D1HttpNodeHandlerOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = chunk as Buffer;
        total += buf.length;
        if (total > MAX_BODY_BYTES) {
          // Close the connection: the unread remainder of the aborted body
          // would otherwise be re-parsed as the next keep-alive request.
          res.setHeader("Connection", "close");
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, errors: [{ message: "Request body too large" }] }), () => req.destroy());
          return;
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);
      const request = new Request(`${`http://${req.headers.host ?? "localhost"}`}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        body: body.length > 0 ? body : undefined,
      });

      if (request.method === "GET" && new URL(request.url).pathname === "/health") {
        // Probe rqlite too: a process-only health check reports "ok" while the
        // write path is down, and web (which waits on this being healthy) would
        // start against a dead database.
        let dbOk = false;
        try {
          // Credentialed probe on the SAME linearizable path as writes. The old
          // anonymous /readyz probe stayed green when credentials were wrong
          // (the '*' user grants ready), so web only failed at first write.
          const authHeader: Record<string, string> = options.basicAuth
            ? { Authorization: toAuthorizationHeader(options.basicAuth) }
            : {};
          const probe = await doFetch(`${options.rqliteUrl}/db/request?transaction=true&associative`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader },
            body: JSON.stringify([["SELECT 1"]]),
          });
          const probeBody = (await probe.json()) as { results?: { error?: string }[] };
          if (!probe.ok || probeBody.results?.[0]?.error) throw new Error("db probe failed");
          dbOk = true;
        } catch {
          dbOk = false;
        }
        res.writeHead(dbOk ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: dbOk ? "ok" : "degraded", database: { connected: dbOk } }));
        return;
      }

      const response = await options.d1.handle(request);
      // appendHeader BEFORE writeHead: after writeHead the header block is
      // composed and appendHeader throws ERR_HTTP_HEADERS_SENT (verified on
      // both Bun and Node 24) — the writeHead-first order turned every
      // response into the catch-all "Internal error" body. appendHeader, not
      // Object.fromEntries: Headers yields repeated Set-Cookie entries
      // separately and a plain object keeps only the last.
      for (const [name, value] of response.headers) res.appendHeader(name, value);
      res.writeHead(response.status);
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      console.error("d1-http request failed", error);
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ success: false, errors: [{ message: "Internal error" }] }));
    });
  };
}

if (import.meta.main) {
  const PORT = Number(process.env.PORT ?? 8788);
  const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
  const TOKEN = requireSecret("CF_D1_API_TOKEN", process.env.CF_D1_API_TOKEN ?? "");

  const BASIC = resolveEnvBasicAuth();
  const server = createD1HttpServer({ baseUrl: RQLITE_URL, token: TOKEN, ...(BASIC ? { basicAuth: BASIC } : {}) });

  const nodeServer = createServer(createD1HttpNodeHandler({ d1: server, rqliteUrl: RQLITE_URL, ...(BASIC ? { basicAuth: BASIC } : {}) }))
    .listen(PORT, "0.0.0.0", () => {
      console.log(`d1-http listening on :${PORT} -> ${RQLITE_URL}`);
    });

  registerShutdownSignals(
    // http.Server.close() returns the Server, not a Promise; wrap the callback
    // so the shutdown handler actually waits for in-flight requests to drain.
    () => new Promise<void>((resolve, reject) => nodeServer.close((err) => (err ? reject(err) : resolve())))
  );
}
