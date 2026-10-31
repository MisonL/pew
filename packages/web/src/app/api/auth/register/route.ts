/**
 * POST /api/auth/register — create a credentials user.
 *
 * Two modes, decided by the server (never by the client):
 *   - Bootstrap: the users table is empty → create the first user as admin
 *     (bootstrapAdmin). Only succeeds until the first user exists.
 *   - Invite: a code from an admin is required (registerWithInvite).
 *
 * Public route: it falls under /api/auth/*, already allowed in proxy.ts. The
 * bootstrap branch is self-limiting (bootstrapAdmin refuses once users exist),
 * so exposing it does not let a second caller seize admin.
 */

import { NextResponse } from "next/server";
import { BodyTooLargeError, MAX_AUTH_BODY_BYTES, readBoundedJson } from "@pew/core";
import { getD1Client } from "@/lib/d1";
import { bootstrapAdmin, registerWithInvite } from "@/lib/credentials";
import {
  AUTH_REGISTER_RATE_LIMIT,
  clientIpKey,
  inMemoryRateLimiter,
} from "@/lib/rate-limit";

const MIN_PASSWORD_LENGTH = 8;

/**
 * The only messages from registerWithInvite that a caller may see verbatim.
 * An explicit set, not a substring match: "no such table: invite_codes" and
 * similar internal text contain the same words.
 */
const CLIENT_FACING_REGISTRATION_ERRORS = new Set([
  "A valid invite code is required to register",
  "Invalid or already used invite code",
  "Instance is already set up",
  "This email address is reserved",
]);

async function instanceIsEmpty(): Promise<boolean> {
  const { results } = await getD1Client().query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users"
  );
  return (results[0]?.n ?? 0) === 0;
}

export async function POST(request: Request) {
  // Rate limit before any password work: an anonymous caller otherwise turns
  // every request into a synchronous scrypt derivation on the event loop.
  const ip = clientIpKey(request);
  const rl = inMemoryRateLimiter.check(`auth-register:${ip}`, AUTH_REGISTER_RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await readBoundedJson(request, MAX_AUTH_BODY_BYTES)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";

  if (!email?.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  let bootstrapping = false;
  try {
    if (await instanceIsEmpty()) {
      bootstrapping = true;
      const { userId } = await bootstrapAdmin({ email, name: name || email, password });
      return NextResponse.json({ ok: true, userId, admin: true });
    }

    const { userId } = await registerWithInvite({ email, name: name || email, password, inviteCode });
    return NextResponse.json({ ok: true, userId, admin: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registration failed";
    // Two concurrent /setup requests can both pass the "instance is empty"
    // pre-check; the loser then hits the users.email UNIQUE index or the
    // instance_setup PRIMARY KEY inside the batch and rolls back (no second
    // admin is created). That is the same client-visible state as the
    // pre-check's "already set up" — not a server fault. Scoped to the
    // bootstrap branch: on the invite path a UNIQUE failure means a duplicate
    // email, which must not be reported as "instance already set up".
    if (bootstrapping && /UNIQUE constraint failed/i.test(message)) {
      return NextResponse.json({ error: "Instance is already set up" }, { status: 400 });
    }
    // Only these two client-facing messages are echoed. Matching on a
    // substring ("invite"/"already") let any internal error text containing
    // those words through — e.g. "no such table: invite_codes" from an
    // unmigrated database, which leaks schema details to an unauthenticated
    // caller. Anything else is a server fault: log it, do not echo internals.
    const clientMessage = err instanceof Error && CLIENT_FACING_REGISTRATION_ERRORS.has(err.message)
      ? err.message : null;
    if (clientMessage !== null) {
      return NextResponse.json({ error: clientMessage }, { status: 400 });
    }
    console.error("Registration failed:", err);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
