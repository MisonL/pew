/**
 * Who may read a profile that is not public.
 *
 * One rule for both entry points: the JSON API (`GET /api/users/[slug]`) and
 * the page that hosts it (`/u/[slug]`). When they disagree the page answers
 * 200 for a private profile while the API answers 404, which both leaks the
 * existence of the slug and shows a broken page.
 */

import type { DbRead } from "@/lib/db";
import type { AuthResult } from "@/lib/auth-helpers";
import { isAdmin, isAdminInDb } from "@/lib/admin";

/**
 * Returns true if the caller is:
 *   1. an admin, OR
 *   2. on the same team as the target user, OR
 *   3. in the same season as the target user (both via registered teams)
 */
export async function canBypassPublic(
  auth: AuthResult,
  db: DbRead,
  targetUserId: string,
): Promise<boolean> {
  // Admin bypass — interactive session only. A Bearer api_key is a
  // long-lived CLI credential that a password reset does not rotate, so a
  // leaked admin key must not read private profiles (same rule as
  // resolveAdmin/isAdminUser).
  if (
    auth.via !== "bearer" &&
    (isAdmin(auth.email) || (await isAdminInDb(auth.userId)))
  ) {
    return true;
  }

  // Teammate check — caller and target share at least one team
  try {
    if (await db.checkSharedTeam(auth.userId, targetUserId)) return true;
  } catch {
    // team_members table may not exist — graceful fallthrough
  }

  // Same-season check — both users belong to teams registered in the same season
  try {
    if (await db.checkSharedSeason(auth.userId, targetUserId)) return true;
  } catch {
    // season_teams table may not exist — graceful fallthrough
  }

  return false;
}
