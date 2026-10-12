/**
 * Entry point for the d1-http container.
 *
 * Serves the D1 REST shape on PORT (default 8788). Only the web container
 * needs to reach it; it is never published to the host.
 */

import { createServer } from "node:http";
import { createD1HttpServer } from "./d1-http";
import { registerShutdownSignals, requireSecret } from "./node-runtime";

const PORT = Number(process.env.PORT ?? 8788);
const RQLITE_URL = process.env.RQLITE_URL ?? "http://rqlite:4001";
const TOKEN = requireSecret("CF_D1_API_TOKEN", process.env.CF_D1_API_TOKEN ?? "");

const server = createD1HttpServer({ baseUrl: RQLITE_URL, token: TOKEN });

const nodeServer = createServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      // A d1-http request is a single SQL batch; 8MB is far beyond any real
      // query and stops a token-holder from OOMing the 512m container.
      if (total > 8 * 1024 * 1024) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, errors: [{ message: "Request body too large" }] }));
        return;
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    const request = new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`), {
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
        const probe = await fetch(`${RQLITE_URL}/readyz`);
        dbOk = probe.ok;
      } catch {
        dbOk = false;
      }
      res.writeHead(dbOk ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: dbOk ? "ok" : "degraded", database: { connected: dbOk } }));
      return;
    }

    const response = await server.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })().catch((error: unknown) => {
    console.error("d1-http request failed", error);
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ success: false, errors: [{ message: "Internal error" }] }));
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`d1-http listening on :${PORT} -> ${RQLITE_URL}`);
});

registerShutdownSignals(
  // http.Server.close() returns the Server, not a Promise; wrap the callback
  // so the shutdown handler actually waits for in-flight requests to drain.
  () => new Promise<void>((resolve, reject) => nodeServer.close((err) => (err ? reject(err) : resolve())))
);
