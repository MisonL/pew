import { NextResponse } from "next/server";

/**
 * JSON for authenticated, user-specific reads and admin responses.
 *
 * A `NextResponse.json` without `Cache-Control` is heuristically cacheable:
 * a shared proxy in front of the app may store a response that carries a
 * user's invites, team roster or comparison matrix and hand it to the next
 * caller. Every response here is private to one session, so it is marked
 * `private, no-store` — the same header the other admin routes already send.
 */
export function privateJson(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { "Cache-Control": "private, no-store", ...init?.headers },
  });
}
