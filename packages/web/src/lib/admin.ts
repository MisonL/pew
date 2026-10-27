/**
 * Admin authorization helpers.
 *
 * Admin status is determined by the ADMIN_EMAILS environment variable,
 * a comma-separated list of email addresses.
 *
 * In E2E mode with admin bypass (E2E_SKIP_AUTH=true + E2E_ADMIN_BYPASS=true
 * + RESOURCE_ENV=test), all users are treated as admins so Playwright tests
 * can exercise admin pages. This is separate from E2E_SKIP_AUTH alone,
 * which only bypasses authentication but preserves admin role checks.
 */

import { resolveUser, type AuthResult, E2E_TEST_USER_ID, E2E_TEST_USER_EMAIL } from "./auth-helpers";
import { getDbRead } from "./db";
import { getD1Client } from "./d1";
import { isE2EMode } from "./e2e-mode";

// ---------------------------------------------------------------------------
// E2E mode checks
// ---------------------------------------------------------------------------

/** Check if admin bypass is enabled (for L3 Playwright tests) */
function isAdminBypass(): boolean {
  return isE2EMode() && process.env.E2E_ADMIN_BYPASS === "true";
}

// ---------------------------------------------------------------------------
// Admin check
// ---------------------------------------------------------------------------

/**
 * Parse the ADMIN_EMAILS env var into a Set of lowercase emails.
 */
function getAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Check if the given email is an admin.
 *
 * Synchronous and env-only (ADMIN_EMAILS) by design: it is called from 30+
 * synchronous sites, and changing its signature to async would ripple
 * everywhere. Deployments that want the first-user-is-admin behaviour rely on
 * `isAdminInDb`, composed in the async resolvers below.
 */
export function isAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  // In E2E mode with admin bypass, all users are admins
  if (isAdminBypass()) return true;
  return getAdminEmails().has(email.toLowerCase());
}

/**
 * Check the in-database admin flag for a user id.
 *
 * Reads through the D1 client directly: the read Worker's user RPCs (lib/db.ts)
 * do not expose `is_admin` and widening them would touch upstream files.
 * Returns false on any error so a database hiccup degrades to "not admin"
 * rather than granting access.
 */
export async function isAdminInDb(userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  try {
    const { results } = await getD1Client().query<{ is_admin: number }>(
      "SELECT is_admin FROM users WHERE id = ?",
      [userId]
    );
    return (results[0]?.is_admin ?? 0) === 1;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resolve admin user (auth + admin check combined)
// ---------------------------------------------------------------------------

export interface AdminResult extends AuthResult {
  email: string;
}

/**
 * Resolve the authenticated user AND verify admin status.
 * Returns null if not authenticated or not an admin.
 *
 * In E2E mode with admin bypass, returns a synthetic admin user for testing.
 */
export async function resolveAdmin(
  request: Request
): Promise<AdminResult | null> {
  // In E2E mode with admin bypass, return synthetic admin user
  if (isAdminBypass()) {
    return { userId: E2E_TEST_USER_ID, email: E2E_TEST_USER_EMAIL };
  }

  const authResult = await resolveUser(request);
  if (!authResult) return null;

  // Admin operations require an interactive session. A Bearer api_key is a
  // long-lived CLI credential that a password reset does NOT rotate, so a
  // leaked key must not be able to reach admin endpoints (reset-password for
  // any user, invites, settings). E2E bypass carries no `via` and passes.
  if (authResult.via === "bearer") return null;

  // resolveUser may not always have the email (e.g. session without email)
  // If email is missing, look it up via RPC
  let email = authResult.email;
  if (!email) {
    const db = await getDbRead();
    email = await db.getUserEmail(authResult.userId) ?? undefined;
  }

  // Admin if on the ADMIN_EMAILS allowlist OR flagged is_admin in the database
  // (the first user created via /setup).
  if (!isAdmin(email) && !(await isAdminInDb(authResult.userId))) return null;

  return { userId: authResult.userId, email: email as string };
}

/**
 * Check if the given AuthResult represents an admin user.
 * Handles case where email may be missing from the auth result.
 *
 * Like resolveAdmin, a Bearer api_key never counts as admin: the CLI key is
 * long-lived and a password reset does not rotate it, so a leaked admin key
 * must not unlock the admin-specific read paths that use this helper (all
 * teams with invite codes, private profiles, all-org listings, leaderboard
 * scope). E2E bypass carries no `via` and stays admin.
 */
export async function isAdminUser(
  authResult: AuthResult
): Promise<boolean> {
  // In E2E mode with admin bypass, all users are admins
  if (isAdminBypass()) return true;
  if (authResult.via === "bearer") return false;

  let email = authResult.email;
  if (!email) {
    const db = await getDbRead();
    email = await db.getUserEmail(authResult.userId) ?? undefined;
  }
  if (isAdmin(email)) return true;
  return isAdminInDb(authResult.userId);
}
