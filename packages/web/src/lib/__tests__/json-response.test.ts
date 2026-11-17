import { describe, expect, it } from "vitest";
import { jsonResponse } from "../json-response";

function req(acceptEncoding?: string): Request {
  const headers: Record<string, string> = {};
  if (acceptEncoding !== undefined) headers["accept-encoding"] = acceptEncoding;
  return new Request("http://localhost/api/test", { headers });
}

const bigBody = { records: Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(50) })) };

describe("jsonResponse", () => {
  it("never compresses at the origin, even when the client accepts gzip", async () => {
    // Next >= 16.4.5 strips `content-encoding` from every route-handler
    // response (commit 2842833 / advisory GHSA-pc58-hwjq-p385). A body
    // compressed here would ship as gzip with no header saying so, and every
    // client would throw `Unexpected token '^_'` parsing it as JSON. The
    // origin therefore always answers identity; the edge sets the encoding.
    for (const encoding of ["gzip, deflate, br", "identity", undefined]) {
      const res = await jsonResponse(req(encoding), bigBody);
      expect(res.status, encoding).toBe(200);
      expect(res.headers.get("content-encoding"), encoding).toBeNull();
      expect(await res.json(), encoding).toEqual(bigBody);
    }
  });

  it("describes the JSON body it actually sends", async () => {
    const res = await jsonResponse(req("gzip"), bigBody);
    const raw = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get("content-type")).toBe("application/json");
    // `vary` still tells any intermediate cache that an encoder will vary its
    // output on this request header.
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(Number(res.headers.get("content-length"))).toBe(raw.byteLength);
    expect(JSON.parse(raw.toString("utf8"))).toEqual(bigBody);
  });

  it("preserves an explicit status and extra headers", async () => {
    const res = await jsonResponse(req("gzip"), { error: "x" }, {
      status: 404,
      headers: { "x-custom": "1" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-custom")).toBe("1");
  });

  describe("ETag revalidation", () => {
    function conditional(etag: string, acceptEncoding = "gzip"): Request {
      return new Request("http://localhost/api/test", {
        headers: { "accept-encoding": acceptEncoding, "if-none-match": etag },
      });
    }

    it("returns a 304 with no body when the client already has this content", async () => {
      const first = await jsonResponse(req("gzip"), bigBody);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^".+"$/);

      const second = await jsonResponse(conditional(etag!), bigBody);
      expect(second.status).toBe(304);
      expect(second.headers.get("etag")).toBe(etag);
      expect(second.headers.get("content-length")).toBeNull();
      expect(second.headers.get("content-encoding")).toBeNull();
      expect((await second.arrayBuffer()).byteLength).toBe(0);
    });

    it("marks the body cacheable but revalidated, which is what keeps the 304 round trip", async () => {
      const res = await jsonResponse(req("gzip"), bigBody);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    });

    it("does not override a Cache-Control the caller set", async () => {
      const res = await jsonResponse(req(), { ok: 1 }, { headers: { "Cache-Control": "public, max-age=60" } });
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("tags the content, not an encoding the origin no longer chooses", async () => {
      // The origin sends one representation for every Accept-Encoding, so the
      // same body must yield the same validator no matter what the client
      // asked for. A per-encoding suffix would miss on a legitimate repeat
      // request and resend the whole body for nothing.
      const gzipClient = await jsonResponse(req("gzip"), bigBody);
      const identityClient = await jsonResponse(req("identity"), bigBody);
      expect(identityClient.headers.get("etag")).toBe(gzipClient.headers.get("etag"));
    });

    it("leaves the encoding suffix to the edge that applies it", async () => {
      // Caddy (and Cloudflare) append their own suffix to a strong ETag and
      // strip it from `If-None-Match` before forwarding, so a validator minted
      // here must not already carry one.
      const etag = (await jsonResponse(req("gzip"), bigBody)).headers.get("etag")!;
      expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    });

    it("accepts weak validators, lists and the wildcard", async () => {
      const etag = (await jsonResponse(req("gzip"), bigBody)).headers.get("etag")!;
      for (const header of [`W/${etag}`, `"other", ${etag}`, "*"]) {
        expect((await jsonResponse(conditional(header), bigBody)).status).toBe(304);
      }
    });

    it("sends the full body when the ETag does not match", async () => {
      const res = await jsonResponse(conditional('"stale"'), bigBody);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(bigBody);
    });

    it("never short-circuits an error status", async () => {
      const etag = (await jsonResponse(req(), { error: "x" })).headers.get("etag")!;
      const res = await jsonResponse(conditional(etag), { error: "x" }, { status: 404 });
      expect(res.status).toBe(404);
    });
  });
});
