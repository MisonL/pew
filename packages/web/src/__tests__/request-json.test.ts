import { describe, it, expect } from "vitest";
import { MAX_JSON_BODY_BYTES } from "@pew/core";
import { readJsonBody } from "@/lib/request-json";

function jsonRequest(body: string): Request {
  return new Request("http://localhost:7020/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("readJsonBody", () => {
  it("parses an object body", async () => {
    const result = await readJsonBody<{ name: string }>(jsonRequest('{"name":"x"}'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual({ name: "x" });
  });

  it("rejects malformed JSON with 400 and the caller's message", async () => {
    const result = await readJsonBody(jsonRequest("not json"), "Invalid JSON body");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect((await result.response.json()).error).toBe("Invalid JSON body");
    }
  });

  it.each(["null", "[]", "42", '"str"'])(
    "rejects non-object JSON %s with 400 instead of a downstream TypeError",
    async (raw) => {
      const result = await readJsonBody(jsonRequest(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(400);
    },
  );

  it("rejects a body above the cap with 413", async () => {
    const big = JSON.stringify({ pad: "a".repeat(MAX_JSON_BODY_BYTES + 1) });
    const result = await readJsonBody(jsonRequest(big));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("accepts a body just under the cap", async () => {
    const nearCap = JSON.stringify({ pad: "a".repeat(MAX_JSON_BODY_BYTES - 64) });
    const result = await readJsonBody(jsonRequest(nearCap));
    expect(result.ok).toBe(true);
  });

  it("rejects an empty body", async () => {
    const result = await readJsonBody(jsonRequest(""));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});
