import { gzip as gzipCallback } from "node:zlib";
import type { ZlibOptions } from "node:zlib";

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

  const acceptsGzip = /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
  const status = init.status ?? 200;

  if (acceptsGzip && Buffer.byteLength(json) >= COMPRESS_MIN_BYTES) {
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

  headers.set("content-length", String(Buffer.byteLength(json)));
  return new Response(json, { status, headers });
}
