import { createHash } from "node:crypto";

/**
 * JSON responses for the large read endpoints, with a content ETag so a
 * revalidation costs no body.
 *
 * These bodies are big: `/api/usage` answers an all-time query with ~6 MB and
 * a dashboard load adds up to ~44 MB. Compression is deliberately NOT done
 * here — see the note below on why the origin serves identity.
 *
 * Node-only by design: the web app runs on the Node runtime (no route in this
 * app sets `runtime = "edge"`), while the Cloudflare deployment is the Worker
 * packages, which never import this module.
 */

/**
 * Why this module no longer gzips its own body.
 *
 * Next 16.4.5 (commit 2842833, advisory GHSA-pc58-hwjq-p385) strips
 * `content-encoding`, `content-length` and `transfer-encoding` from EVERY
 * route-handler response, unconditionally. The patch assumes the body may
 * have been transparently decoded by `fetch()`, which is true for a handler
 * that returns an upstream response verbatim — but it is also true of nothing
 * else, and the check cannot tell the two apart. A handler that compresses its
 * own body therefore ships gzip bytes with no `Content-Encoding`, and every
 * client fails with `Unexpected token '^_'` while parsing the response as
 * JSON. Verified on 16.4.3 / 16.4.4 (header kept) against 16.4.5 (header
 * dropped) with a standalone production build.
 *
 * There is no supported escape hatch: a `Response` body of `Uint8Array`,
 * `Buffer` or `ReadableStream` is filtered the same way, `compress: false`
 * changes nothing, and the proxy (middleware) cannot re-add the header either.
 * Next's own `compress` option does not cover route-handler bodies at all.
 *
 * So the origin serves identity-encoded JSON and the encoding happens in the
 * edge that terminates TLS, where it is also free of this bug:
 * - hosted: Cloudflare already answers these with `content-encoding: br`.
 * - self-hosted behind Caddy: the `encode zstd gzip` directive in
 *   `deploy/selfhost/Caddyfile`. Caddy appends its own suffix to a strong
 *   ETag and strips it from `If-None-Match`, so the 304 path keeps working.
 * A self-hosted deployment published straight from port 7020 without a proxy
 * sends these bodies uncompressed; the README names Caddy as the supported
 * shape for anything beyond a trusted LAN.
 */

/**
 * Next keeps SWR-mounted data alive across client navigations, but a remount
 * revalidates: `/api/usage` answers a 2020-start all-time query with ~5 MB,
 * and the analytics pages share that one query, so every hop between
 * /dashboard, /agents and /models re-downloaded an identical body. A content
 * ETag turns that revalidation into a 304 with no body.
 *
 * The tag carries no encoding suffix now that the origin always answers
 * identity: the edge that compresses the body is responsible for marking its
 * representation, which is what Caddy and Cloudflare both do. The digest is
 * taken over the JSON, so a revalidation is answered without touching bytes.
 */
function etagFor(json: string): string {
  const digest = createHash("sha1").update(json).digest("base64url").slice(0, 22);
  return `"${digest}"`;
}

/** Matches the If-None-Match grammar, weak validators and `*` included. */
function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const tags = header.split(",").map((t) => t.trim());
  return tags.includes("*") || tags.some((t) => t.replace(/^W\//, "") === etag);
}

export async function jsonResponse(
  request: Request,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Promise<Response> {
  const json = JSON.stringify(body);
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  // The edge that compresses this body varies its output on Accept-Encoding,
  // and a cache in front of the app must key on the same header. The origin
  // itself always answers identity, so this is advisory, not a description of
  // what left this process.
  headers.set("vary", "accept-encoding");
  // These bodies are per-user and must never be served from a shared cache.
  // `private, no-cache` stores them in the browser but forces revalidation,
  // which is what lets the ETag below turn a remount into an empty 304.
  // Callers that need different semantics (e.g. the public pricing map's
  // max-age) pass their own Cache-Control.
  if (!headers.has("cache-control")) headers.set("cache-control", "private, no-cache");

  const status = init.status ?? 200;

  // A conditional request that already holds this body gets the headers and
  // no payload.
  const etag = etagFor(json);
  headers.set("etag", etag);
  if (status === 200 && matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const bytes = Buffer.from(json, "utf8");
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, { status, headers });
}
