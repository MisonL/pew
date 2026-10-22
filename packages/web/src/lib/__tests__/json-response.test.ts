import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { jsonResponse } from "../json-response";

function req(acceptEncoding?: string): Request {
  const headers: Record<string, string> = {};
  if (acceptEncoding !== undefined) headers["accept-encoding"] = acceptEncoding;
  return new Request("http://localhost/api/test", { headers });
}

describe("jsonResponse", () => {
  it("gzips a large body when the client accepts gzip", async () => {
    const body = { records: Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(50) })) };
    const res = await jsonResponse(req("gzip, deflate, br"), body);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("content-type")).toBe("application/json");

    const raw = Buffer.from(await res.arrayBuffer());
    // The declared length is the compressed size, not the JSON size.
    expect(Number(res.headers.get("content-length"))).toBe(raw.byteLength);
    expect(raw.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(body)));
    expect(JSON.parse(gunzipSync(raw).toString("utf8"))).toEqual(body);
  });

  it("sends plain JSON when the client does not accept gzip", async () => {
    const body = { records: Array.from({ length: 200 }, (_, i) => ({ i })) };
    const res = await jsonResponse(req(), body);

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(body);
  });

  it("sends plain JSON when gzip is explicitly refused", async () => {
    const res = await jsonResponse(req("identity"), { ok: true });
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("skips compression below the threshold even when gzip is accepted", async () => {
    const res = await jsonResponse(req("gzip"), { ok: true });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
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
    const body = { records: Array.from({ length: 200 }, (_, i) => ({ i, pad: "x".repeat(50) })) };

    function conditional(etag: string, acceptEncoding = "gzip"): Request {
      return new Request("http://localhost/api/test", {
        headers: { "accept-encoding": acceptEncoding, "if-none-match": etag },
      });
    }

    it("returns a 304 with no body when the client already has this content", async () => {
      const first = await jsonResponse(req("gzip"), body);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^".+"$/);

      const second = await jsonResponse(conditional(etag!), body);
      expect(second.status).toBe(304);
      expect(second.headers.get("etag")).toBe(etag);
      expect(second.headers.get("content-length")).toBeNull();
      expect(second.headers.get("content-encoding")).toBeNull();
      expect((await second.arrayBuffer()).byteLength).toBe(0);
    });

    it("marks the body cacheable but revalidated, which is what keeps the 304 round trip", async () => {
      const res = await jsonResponse(req("gzip"), body);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
    });

    it("does not override a Cache-Control the caller set", async () => {
      const res = await jsonResponse(req(), { ok: 1 }, { headers: { "Cache-Control": "public, max-age=60" } });
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("names the representation so a client that changes encoding gets the body", async () => {
      const gzipped = await jsonResponse(req("gzip"), body);
      const plain = await jsonResponse(req("identity"), body);
      expect(plain.headers.get("etag")).not.toBe(gzipped.headers.get("etag"));

      const revalidated = await jsonResponse(conditional(gzipped.headers.get("etag")!, "identity"), body);
      expect(revalidated.status).toBe(200);
      expect(await revalidated.json()).toEqual(body);
    });

    it("accepts weak validators, lists and the wildcard", async () => {
      const etag = (await jsonResponse(req("gzip"), body)).headers.get("etag")!;
      for (const header of [`W/${etag}`, `"other", ${etag}`, "*"]) {
        expect((await jsonResponse(conditional(header), body)).status).toBe(304);
      }
    });

    it("sends the full body when the ETag does not match", async () => {
      const res = await jsonResponse(conditional('"stale"'), body);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
    });

    it("never short-circuits an error status", async () => {
      const etag = (await jsonResponse(req(), { error: "x" })).headers.get("etag")!;
      const res = await jsonResponse(conditional(etag), { error: "x" }, { status: 404 });
      expect(res.status).toBe(404);
    });
  });
});
