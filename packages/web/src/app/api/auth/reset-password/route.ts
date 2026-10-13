/**
 * POST /api/auth/reset-password — consume a reset token and set a new password.
 *
 * Public route (falls under /api/auth/*). The token itself is the credential;
 * it is single-use and expires. On success, existing sessions are invalidated
 * because the JWT's password version no longer matches (see auth.ts).
 */

import { NextResponse } from "next/server";
import { consumePasswordReset } from "@/lib/credentials";

const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!token) {
    return NextResponse.json({ error: "A reset token is required" }, { status: 400 });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  try {
    const result = await consumePasswordReset(token, password);
    if (!result) {
      return NextResponse.json({ error: "Invalid or expired reset token" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to reset password:", err);
    return NextResponse.json({ error: "Failed to reset password" }, { status: 500 });
  }
}
