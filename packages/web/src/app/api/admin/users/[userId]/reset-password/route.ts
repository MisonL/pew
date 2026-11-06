/**
 * POST /api/admin/users/[userId]/reset-password — issue a password-reset token.
 *
 * Admin-only. There is no email capability in the self-hosted deployment
 * (spec §4.4), so the response carries a single-use token the admin hands to
 * the user out of band. The user then POSTs it back to
 * /api/auth/reset-password with a new password.
 *
 * Returns { token, expiresInMinutes }.
 */

import { NextResponse } from "next/server";
import { resolveAdmin } from "@/lib/admin";
import { createPasswordReset, RESET_TOKEN_TTL_MINUTES } from "@/lib/credentials";
import { getDbRead } from "@/lib/db";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const admin = await resolveAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ error: "User id is required" }, { status: 400 });
  }

  try {
    // password_resets.user_id references users(id). Without this check a
    // deleted or mistyped id fails the insert with a foreign-key error (500),
    // and on a backend with foreign keys off it stores a token whose
    // consumption burns itself and updates zero rows, answering 200 with the
    // password unchanged.
    const dbRead = await getDbRead();
    const target = await dbRead.getUserById(userId);
    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const token = await createPasswordReset(userId);
    return NextResponse.json({ token, expiresInMinutes: RESET_TOKEN_TTL_MINUTES });
  } catch (err) {
    console.error("Failed to create password reset:", err);
    return NextResponse.json({ error: "Failed to create reset token" }, { status: 500 });
  }
}
