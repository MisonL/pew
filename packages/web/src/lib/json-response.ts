import { gzip as gzipCallback } from "node:zlib";
import type { ZlibOptions } from "node:zlib";
import { createHash } from "node:crypto";

/**
 * JSON responses for the large read endpoints, gzip-compressed when the
 * client asks for it.
 *
 * Next.js's built-in `compress` covers HTML and static chunks but NOT App
 * Router route-handler responses, so `/api/usage` and `/api/usage/by-device`
 * were shipped raw: measured 6.37 MB for one all-time query, 44 MB for a
 * dashboard load. Gzip on that body is 11.9x, so this is the single largest
 * win available without changing the API contract.
 *
 * The hosted deployment sits behind Cloudflare, which already returns
 * `content-encoding: br` for these responses — sending gzip from the origin is
 * harmless there (Cloudflare passes it through) and is what makes a
 * self-hosted deployment usable without a reverse proxy.
 *
 * Node-only by design: the web app runs on the Node runtime (no route in this
 * app sets `runtime = "edge"`), while the Cloudflare deployment is the Worker
 * packages, which never import this module.
 */

/** Below this size the gzip header overhead outweighs the saving. */
const COMPRESS_MIN_BYTES = 1024;

/**
 * Next keeps SWR-mounted data alive across client navigations, but a remount
 * revalidates: `/api/usage` answers a 2020-start all-time query with ~5 MB,
 * and the analytics pages share that one query, so every hop between
 * /dashboard, /agents and /models re-downloaded an identical body. A content
 * ETag turns that revalidation into a 304 with no body.
 *
 * The tag names the encoding it was computed for, so a client that switches
 * between gzip and identity never revalidates against a validator that
 * belongs to the other representation — the same reason `Vary:
 * accept-encoding` is set. The digest itself is taken over the JSON, so a
 * revalidation can be answered without compressing the body at all: the gzip
 * of a 5.7 MB body costs more than the digest does.
 */
function etagFor(json: string, encoded: boolean): string {
  const digest = createHash("sha1").update(json).digest("base64url").slice(0, 22);
  return `"${digest}-${encoded ? "gzip" : "id"}"`;
}

/** Matches the If-None-Match grammar, weak validators and `*` included. */
function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const tags = header.split(",").map((t) => t.trim());
  return tags.includes("*") || tags.some((t) => t.replace(/^W\//, "") === etag);
}

function gzipAsync(input: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const options: ZlibOptions = {};
    gzipCallback(input, options, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

export async function jsonResponse(
  request: Request,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Promise<Response> {
  const json = JSON.stringify(body);
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  // The response varies on Accept-Encoding, so any cache in front of it must
  // key on that header.
  headers.set("vary", "accept-encoding");
  // These bodies are per-user and must never be served from a shared cache.
  // `private, no-cache` stores them in the browser but forces revalidation,
  // which is what lets the ETag below turn a remount into an empty 304.
  // Callers that need different semantics (e.g. the public pricing map's
  // max-age) pass their own Cache-Control.
  if (!headers.has("cache-control")) headers.set("cache-control", "private, no-cache");

  const acceptsGzip = /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
  const status = init.status ?? 200;
  const encoded = acceptsGzip && Buffer.byteLength(json) >= COMPRESS_MIN_BYTES;

  // A conditional request that already holds this body gets the headers and
  // no payload. Nothing is compressed for it.
  const etag = etagFor(json, encoded);
  headers.set("etag", etag);
  if (status === 200 && matchesEtag(request.headers.get("if-none-match"), etag)) {
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(null, { status: 304, headers });
  }

  if (encoded) {
    // Async: a 6 MB payload takes tens of milliseconds to deflate, and the web
    // app is a single process — a sync call here would stall every concurrent
    // request.
    const compressed = await gzipAsync(json);
    headers.set("content-encoding", "gzip");
    // The compressed length, not the JSON length: without it the response is
    // chunked and clients cannot show progress or size.
    headers.set("content-length", String(compressed.byteLength));
    // Copy into a plain ArrayBuffer-backed view: zlib returns a view over
    // ArrayBufferLike (which admits SharedArrayBuffer), and the DOM BodyInit
    // type only accepts the non-shared form.
    const bytes = new Uint8Array(compressed.byteLength);
    bytes.set(compressed);
    return new Response(bytes, { status, headers });
  }

  const bytes = Buffer.from(json, "utf8");
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, { status, headers });
}
