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
});
