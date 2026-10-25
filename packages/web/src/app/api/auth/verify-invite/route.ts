/**
 * POST /api/auth/verify-invite — public invite code verification.
 *
 * Validates the code exists and is unused (read-only check), then sets
 * a `pew-invite-code` cookie for the signIn callback to consume.
 *
 * This route is public — it falls under `/api/auth/*` which is already
 * allowed in proxy.ts.
 */

import { NextResponse } from "next/server";
import { BodyTooLargeError, MAX_AUTH_BODY_BYTES, readBoundedJson } from "@pew/core";
import { getDbRead } from "@/lib/db";
import { validateInviteCode } from "@/lib/invite";
import {
  AUTH_VERIFY_INVITE_RATE_LIMIT,
  getClientIp,
  inMemoryRateLimiter,
} from "@/lib/rate-limit";
import { shouldUseSecureCookies } from "@/auth";

export async function POST(request: Request) {
  // Rate limit: 5 checks per minute per IP. This endpoint is public and answers
  // "does this code exist and is it unused?" without consuming the code, so
  // unlike every other auth route it could otherwise be queried without bound.
  const ip = getClientIp(request);
  const rl = inMemoryRateLimiter.check(
    `auth-verify-invite:${ip}`,
    AUTH_VERIFY_INVITE_RATE_LIMIT,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { valid: false, error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await readBoundedJson(request, MAX_AUTH_BODY_BYTES)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json(
        { valid: false, error: error.message },
        { status: 413 }
      );
    }
    return NextResponse.json(
      { valid: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const { code } = body;

  // Format validation
  if (!validateInviteCode(code)) {
    return NextResponse.json(
      { valid: false, error: "Invalid invite code format" },
      { status: 400 }
    );
  }

  const db = await getDbRead();

  try {
    // Read-only check — does NOT consume the code
    const row = await db.checkInviteCodeExists(code);

    if (!row || row.used_by !== null) {
      return NextResponse.json(
        { valid: false, error: "Invalid or already used invite code" },
        { status: 400 }
      );
    }

    // Set the cookie for the signIn callback to read
    const secure = shouldUseSecureCookies();
    const response = NextResponse.json({ valid: true });
    response.cookies.set("pew-invite-code", code, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: 600, // 10 minutes
    });

    return response;
  } catch (err) {
    console.error("Failed to verify invite code:", err);
    return NextResponse.json(
      { valid: false, error: "Failed to verify invite code" },
      { status: 500 }
    );
  }
}
