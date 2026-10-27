import { BodyTooLargeError, MAX_JSON_BODY_BYTES, readBoundedJson } from "@pew/core";
import { NextResponse } from "next/server";

/**
 * Bounded JSON body reader for the authenticated write routes.
 *
 * `request.json()` has no size limit, so any signed-in caller (or a leaked
 * Bearer key) can make the single web process buffer an arbitrary payload.
 * Every route using this helper takes a handful of short fields, so
 * MAX_JSON_BODY_BYTES is far above any legitimate body.
 *
 * Returns a discriminated union instead of throwing so each route keeps its
 * own error wording (`Invalid JSON` vs `Invalid JSON body`).
 */
export type JsonBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

export async function readJsonBody<T = Record<string, unknown>>(
  request: Request,
  invalidMessage = "Invalid JSON",
): Promise<JsonBodyResult<T>> {
  let parsed: unknown;
  try {
    parsed = await readBoundedJson(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        ok: false,
        response: NextResponse.json({ error: error.message }, { status: 413 }),
      };
    }
    return {
      ok: false,
      response: NextResponse.json({ error: invalidMessage }, { status: 400 }),
    };
  }

  // `JSON.parse("null")`, a bare number or an array would otherwise reach
  // `body.name` and throw a TypeError — a 500 for what is plainly bad input.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: NextResponse.json({ error: invalidMessage }, { status: 400 }),
    };
  }

  return { ok: true, body: parsed as T };
}
