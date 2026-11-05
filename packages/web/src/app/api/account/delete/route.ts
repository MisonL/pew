/**
 * DELETE /api/account/delete — permanently delete user account
 *
 * Requires email confirmation in request body to prevent accidental deletion.
 * Deletes all user data including:
 * - User record and auth tokens
 * - Usage records and session records
 * - Team memberships (but not teams the user created)
 * - Invite codes created by user
 */

import { NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth-helpers";
import { unauthorizedResponse } from "@/lib/api-responses";
import { getDbRead, getDbWrite } from "@/lib/db";
import { readJsonBody } from "@/lib/request-json";

// ---------------------------------------------------------------------------
// DELETE — permanently delete account
// ---------------------------------------------------------------------------

export async function DELETE(request: Request) {
  // Account deletion is a destructive action — only allow browser session auth.
  // Reject API key (Bearer token) authentication with 403.
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      {
        error:
          "Account deletion requires browser session authentication. API key authentication is not allowed for this action.",
      },
      { status: 403 },
    );
  }

  const authResult = await resolveUser(request);
  if (!authResult) {
    return unauthorizedResponse();
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const confirmEmail = parsed.body.confirm_email;
  if (typeof confirmEmail !== "string" || !confirmEmail.trim()) {
    return NextResponse.json(
      { error: "confirm_email is required" },
      { status: 400 },
    );
  }

  const dbRead = await getDbRead();
  const dbWrite = await getDbWrite();

  // Fetch user record to verify email matches
  const user = await dbRead.getUserById(authResult.userId);

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Verify email confirmation matches
  if (confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "Email does not match. Account deletion cancelled." },
      { status: 400 },
    );
  }

  try {
    const userId = authResult.userId;
    // One batch, ordered so the row that makes the account disappear
    // (`DELETE FROM users`) is last: atomic on the self-hosted rqlite adapter,
    // not documented for the hosted D1 REST endpoint (see lib/d1.ts). A partial
    // failure that stops before that row leaves the account intact, so the
    // delete can be retried. Two retry caveats in that window: statement 1
    // decrements the team snapshot by this user's member row (statement 8),
    // which still exists — a retry after a partial apply subtracts a second
    // time (MAX(0, …) only prevents going negative); and a failure after
    // statement 8 but before the last one leaves the snapshot already
    // decremented. Neither is recoverable by the retry itself; a re-run of the
    // snapshot job recomputes the totals.
    await dbWrite.batch([
      {
        sql: `UPDATE season_snapshots AS ss SET
          total_tokens = MAX(0, ss.total_tokens - ms.total_tokens),
          input_tokens = MAX(0, ss.input_tokens - ms.input_tokens),
          output_tokens = MAX(0, ss.output_tokens - ms.output_tokens),
          cached_input_tokens = MAX(0, ss.cached_input_tokens - ms.cached_input_tokens)
          FROM season_member_snapshots ms
          WHERE ms.season_id = ss.season_id AND ms.team_id = ss.team_id AND ms.user_id = ?`,
        params: [userId],
      },
      {
        sql: `WITH ranked AS (
          SELECT season_id, team_id, ROW_NUMBER() OVER (
            PARTITION BY season_id ORDER BY total_tokens DESC, team_id) AS new_rank
          FROM season_snapshots WHERE season_id IN (
            SELECT season_id FROM season_member_snapshots WHERE user_id = ?))
          UPDATE season_snapshots AS ss SET rank = ranked.new_rank FROM ranked
          WHERE ss.season_id = ranked.season_id AND ss.team_id = ranked.team_id`,
        params: [userId],
      },
      { sql: "DELETE FROM usage_details WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM usage_evidence WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM usage_records WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM session_records WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM team_members WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM season_member_snapshots WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM season_team_members WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM device_aliases WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM organization_members WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM auth_codes WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM sessions WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM accounts WHERE user_id = ?", params: [userId] },
      { sql: "DELETE FROM invite_codes WHERE created_by = ?", params: [userId] },
      { sql: "UPDATE invite_codes SET used_by = 'deleted-user' WHERE used_by = ?", params: [userId] },
      // instance_setup has no foreign key to users, so deleting the bootstrap
      // admin would leave a row pointing at a missing id. bootstrapAdmin
      // inserts with a hardcoded id=1, so that stale row makes every later
      // /setup attempt collide on the primary key and roll back its users
      // INSERT too — the instance could never be set up again. Clearing it
      // here lets the next /setup re-bootstrap a fresh admin.
      { sql: "DELETE FROM instance_setup WHERE admin_user_id = ?", params: [userId] },
      { sql: "DELETE FROM users WHERE id = ?", params: [userId] },
    ]);

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message)) {
      // Name what actually blocks the delete. The previous wording told the
      // operator to "transfer or remove" the resources, but no transfer route
      // exists (teams/seasons/organizations all keep a NOT NULL created_by, and
      // there is no reassignment API), so the only honest instruction is what
      // can be removed and by which means. Diagnose on the failure path only:
      // the happy path stays a single batch.
      const blockers = await describeAccountDeleteBlockers(dbWrite, authResult.userId).catch(() => "");
      return NextResponse.json(
        {
          error: blockers
            ? `Account still owns shared resources: ${blockers}.`
            : "Account still owns shared resources that must be removed before the account can be deleted.",
        },
        { status: 409 },
      );
    }
    console.error("Failed to delete account:", err);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 },
    );
  }
}

/**
 * List the resources whose NOT NULL `created_by` (or `registered_by`) still
 * points at this user, with the concrete way to remove each.
 *
 * Mirrors the locked-season predicate in `teams/[teamId]` DELETE: a team
 * registered in a season that has ended, or that has started and does not
 * allow late withdrawal, cannot be deleted or left through the API — so its
 * owner is genuinely stuck until an operator intervenes. The season itself
 * can now be removed by an admin via `DELETE /api/admin/seasons/{seasonId}`,
 * which is what the message instructs.
 */
async function describeAccountDeleteBlockers(
  dbWrite: Awaited<ReturnType<typeof getDbWrite>>,
  userId: string,
): Promise<string> {
  const lockedSeason = `SELECT 1 FROM season_teams st JOIN seasons s ON s.id = st.season_id
    WHERE st.team_id = t.id AND (julianday(s.end_date, '+1 minute') <= julianday('now') OR
      (julianday(s.start_date) <= julianday('now') AND COALESCE(s.allow_late_withdrawal, 0) = 0))`;
  const otherMember = "EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id != ?)";
  // `registered_by` is written only by the register route (which requires
  // `membership === "owner"`) and by auto-register (`getTeamOwner(team.id) ??
  // team.created_by`), so it is always the team owner and this count is zero on
  // data the current API can produce — it is kept for rows left by an older
  // schema. It must NOT be split into locked/open halves pointing at
  // DELETE /api/seasons/{seasonId}/register: that route is owner-only, so for a
  // registrant who does not own the team it is a 403. Only an admin deleting
  // the season clears such a row unconditionally: the owner-withdraw route also
  // refuses an ended season ("Cannot withdraw from ended seasons") and an
  // active season without late withdrawal, so it is not an alternative to name.
  const registrationsNotOwner = `SELECT COUNT(*) AS n FROM season_teams st
    WHERE st.registered_by = ?
      AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = st.team_id AND t.created_by = ?)`;
  const counts = await dbWrite.batch([
    { sql: "SELECT COUNT(*) AS n FROM seasons WHERE created_by = ?", params: [userId] },
    { sql: "SELECT COUNT(*) AS n FROM organizations WHERE created_by = ?", params: [userId] },
    { sql: `SELECT COUNT(*) AS n FROM teams t WHERE t.created_by = ? AND EXISTS (${lockedSeason})`, params: [userId] },
    // Owner with other members: DELETE /api/teams/{teamId} refuses until the
    // others are removed, so that removal has to be part of the instruction.
    { sql: `SELECT COUNT(*) AS n FROM teams t WHERE t.created_by = ? AND NOT EXISTS (${lockedSeason}) AND ${otherMember}`, params: [userId, userId] },
    { sql: `SELECT COUNT(*) AS n FROM teams t WHERE t.created_by = ? AND NOT EXISTS (${lockedSeason}) AND NOT (${otherMember})`, params: [userId, userId] },
    { sql: registrationsNotOwner, params: [userId, userId] },
  ]);
  const n = (i: number): number => {
    const row = counts[i]?.results?.[0] as { n?: number } | undefined;
    return row?.n ?? 0;
  };
  const parts: string[] = [];
  if (n(0) > 0) parts.push(`${n(0)} season(s) you created (delete as admin: DELETE /api/admin/seasons/{seasonId})`);
  if (n(1) > 0) parts.push(`${n(1)} organization(s) you created (delete as admin: DELETE /api/admin/organizations/{orgId})`);
  if (n(2) > 0) parts.push(`${n(2)} team(s) registered in a locked season (delete the season as admin first: DELETE /api/admin/seasons/{seasonId})`);
  if (n(3) > 0) parts.push(`${n(3)} team(s) you created with other members (remove the other members first, then DELETE /api/teams/{teamId})`);
  if (n(4) > 0) parts.push(`${n(4)} team(s) you created (delete first: DELETE /api/teams/{teamId})`);
  if (n(5) > 0) parts.push(`${n(5)} registration(s) under your name for a team you do not own (delete the season as admin: DELETE /api/admin/seasons/{seasonId})`);
  return parts.join("; ");
}
