/**
 * POST /api/teams/join — join a team by invite code.
 */

import { NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth-helpers";
import { getDbRead, getDbWrite } from "@/lib/db";
import { inMemoryRateLimiter, TEAM_JOIN_RATE_LIMIT } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-json";
import { syncSeasonRosters } from "@/lib/season-roster";

export async function POST(request: Request) {
  const authResult = await resolveUser(request);
  if (!authResult) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 5 join attempts per minute per user
  const rl = inMemoryRateLimiter.check(
    `team-join:${authResult.userId}`,
    TEAM_JOIN_RATE_LIMIT,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many join attempts. Please try again later." },
      { status: 429 },
    );
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const inviteCode = body.invite_code;
  if (typeof inviteCode !== "string" || inviteCode.length === 0) {
    return NextResponse.json(
      { error: "invite_code is required" },
      { status: 400 },
    );
  }

  if (!/^[a-f0-9]{32}$/.test(inviteCode)) {
    return NextResponse.json({ error: "Invalid invite code format" }, { status: 400 });
  }

  try {
    const dbRead = await getDbRead();
    const dbWrite = await getDbWrite();

    // Find team by invite code
    const team = await dbRead.findTeamByInviteCode(inviteCode);

    if (!team) {
      return NextResponse.json(
        { error: "Invalid invite code" },
        { status: 404 },
      );
    }

    // Check if already a member
    const isMember = await dbRead.checkTeamMembershipExists(team.id, authResult.userId);

    if (isMember) {
      return NextResponse.json(
        { error: "Already a member of this team" },
        { status: 409 },
      );
    }

    // Enforce team member limit from app_settings (default: 5)
    const DEFAULT_MAX_TEAM_MEMBERS = 5;
    let maxMembers = DEFAULT_MAX_TEAM_MEMBERS;
    try {
      const settingValue = await dbRead.getAppSetting("max_team_members");
      if (settingValue) {
        const parsed = parseInt(settingValue, 10);
        if (!Number.isNaN(parsed) && parsed > 0) maxMembers = parsed;
      }
    } catch {
      // Settings table may not exist yet — use default
    }

    // Atomic check+insert: INSERT only if team is under the member limit AND
    // the caller is not already a member. The membership predicate is not
    // redundant with the read above: two concurrent joins (a double-click, or
    // a retried request) both pass that read, and the loser would hit
    // UNIQUE(team_id, user_id) as a generic 500 instead of the 409 this route
    // promises. With it, the loser matches zero rows and gets 409 below.
    const result = await dbWrite.execute(
      `INSERT INTO team_members (id, team_id, user_id, role, joined_at)
       SELECT ?, ?, ?, 'member', datetime('now')
       WHERE (SELECT COUNT(*) FROM team_members WHERE team_id = ?) < ?
         AND NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?)`,
      [crypto.randomUUID(), team.id, authResult.userId, team.id, maxMembers, team.id, authResult.userId],
    );

    if (result.changes === 0) {
      // Distinguish "already a member" from "team is full" so a repeated
      // request is idempotent rather than reporting a misleading 403.
      const joined = await dbRead.checkTeamMembershipExists(team.id, authResult.userId);
      if (joined) {
        return NextResponse.json(
          { error: "Already a member of this team" },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: `Team is full (max ${maxMembers} members)` },
        { status: 403 },
      );
    }

    // Sync season rosters if any active season allows roster changes
    try {
      await syncSeasonRosters(dbRead, dbWrite, team.id);
    } catch (err) {
      console.error("Failed to sync season rosters after join:", err);
    }

    return NextResponse.json({
      team_id: team.id,
      team_name: team.name,
      team_slug: team.slug,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) {
      return NextResponse.json(
        { error: "Teams feature not available yet — database migration pending" },
        { status: 503 },
      );
    }
    console.error("Failed to join team:", err);
    return NextResponse.json({ error: "Failed to join team" }, { status: 500 });
  }
}
