import { handlers } from "@/auth";
import { MAX_AUTH_BODY_BYTES } from "@pew/core";
import { NextRequest } from "next/server";

export const { GET } = handlers;

/**
 * POST with a bounded body.
 *
 * Auth.js reads the body itself (`request.formData()` / `request.json()`) and
 * has no size limit, so an anonymous caller could make the web process buffer
 * an arbitrarily large payload on the sign-in, callback and sign-out routes.
 * Every body these endpoints accept is a handful of short fields, so
 * MAX_AUTH_BODY_BYTES is far above any legitimate request. The body is read
 * once under the cap and handed to the handler as a fresh request, which
 * keeps the declared Content-Length shortcut honest for chunked uploads.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size > MAX_AUTH_BODY_BYTES) {
      return tooLarge();
    }
  }

  if (!request.body) return handlers.POST(request);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUTH_BODY_BYTES) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return handlers.POST(new NextRequest(request, { body }));
}

function tooLarge(): Response {
  return Response.json({ error: "Request body too large" }, { status: 413 });
}
