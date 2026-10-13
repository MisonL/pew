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
    const token = await createPasswordReset(userId);
    return NextResponse.json({ token, expiresInMinutes: RESET_TOKEN_TTL_MINUTES });
  } catch (err) {
    console.error("Failed to create password reset:", err);
    return NextResponse.json({ error: "Failed to create reset token" }, { status: 500 });
  }
}
