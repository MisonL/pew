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
import { getD1Client } from "@/lib/d1";
import { bootstrapAdmin, registerWithInvite } from "@/lib/credentials";

const MIN_PASSWORD_LENGTH = 8;

async function instanceIsEmpty(): Promise<boolean> {
  const { results } = await getD1Client().query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users"
  );
  return (results[0]?.n ?? 0) === 0;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
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

  try {
    if (await instanceIsEmpty()) {
      const { userId } = await bootstrapAdmin({ email, name: name || email, password });
      return NextResponse.json({ ok: true, userId, admin: true });
    }

    const { userId } = await registerWithInvite({ email, name: name || email, password, inviteCode });
    return NextResponse.json({ ok: true, userId, admin: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registration failed";
    // Invite problems and "already set up" are the caller's to act on (400);
    // anything else is a server fault — log it but do not echo internals.
    const clientError = /invite|already/i.test(message);
    if (clientError) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error("Registration failed:", err);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
