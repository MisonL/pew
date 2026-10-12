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
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const request = new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`), {
      method: req.method ?? "GET",
      headers: req.headers as Record<string, string>,
      body: body.length > 0 ? body : undefined,
    });

    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
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
