/**
 * POST/DELETE /api/seasons/[seasonId]/register — season team registration.
 *
 * - POST   → register a team for the season (team owner only)
 * - DELETE → withdraw a team from the season (team owner only, upcoming only)
 */

import { NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth-helpers";
import { getDbRead, getDbWrite } from "@/lib/db";
import { readJsonBody } from "@/lib/request-json";
import { deriveSeasonStatus } from "@/lib/seasons";

// ---------------------------------------------------------------------------
// POST — register team for season
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ seasonId: string }> }
) {
  const user = await resolveUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { seasonId } = await params;

  const parsed = await readJsonBody<{ team_id?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const { team_id } = parsed.body;
  if (!team_id || typeof team_id !== "string") {
    return NextResponse.json(
      { error: "team_id is required" },
      { status: 400 }
    );
  }

  const dbRead = await getDbRead();
  const dbWrite = await getDbWrite();

  try {
    // Verify season exists
    const season = await dbRead.getSeasonById(seasonId);

    if (!season) {
      return NextResponse.json(
        { error: "Season not found" },
        { status: 404 }
      );
    }

    const status = deriveSeasonStatus(season.start_date, season.end_date);
    if (status === "ended") {
      return NextResponse.json(
        { error: "Cannot register for ended seasons" },
        { status: 400 }
      );
    }
    if (status === "active" && !season.allow_late_registration) {
      return NextResponse.json(
        { error: "Registration closed — season already started" },
        { status: 400 }
      );
    }

    // Verify user is team owner
    const membership = await dbRead.getTeamMembership(team_id, user.userId);

    if (!membership || membership !== "owner") {
      return NextResponse.json(
        { error: "Only team owners can register for seasons" },
        { status: 403 }
      );
    }

    // Check duplicate registration
    const existing = await dbRead.getSeasonRegistration(seasonId, team_id);

    if (existing) {
      return NextResponse.json(
        { error: "Team is already registered for this season" },
        { status: 409 }
      );
    }

    // Fetch current team members to freeze into season roster
    const members = await dbRead.getTeamMembers(team_id);

    // Pre-validate: ensure no member is already registered for this season
    // via another team (UNIQUE(season_id, user_id) would reject anyway,
    // but checking upfront avoids partial writes)
    if (members.length > 0) {
      const userIds = members.map((m) => m.user_id);
      const conflict = await dbRead.checkSeasonMemberConflict(seasonId, userIds);
      if (conflict) {
        return NextResponse.json(
          { error: "A team member is already registered for this season on another team" },
          { status: 409 }
        );
      }
    }

    // Write registration + frozen roster in a single batch.
    // D1 REST API batch() is NOT transactional — it executes statements
    // sequentially. If one fails, earlier ones are already committed.
    // On partial failure we compensate by deleting only the rows WE created
    // (identified by their UUIDs), never by (season_id, team_id) which
    // would also wipe data from a concurrent successful request.
    const id = crypto.randomUUID();
    const memberIds = members.map(() => crypto.randomUUID());
    const statements: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: `INSERT INTO season_teams (id, season_id, team_id, registered_by)
              VALUES (?, ?, ?, ?)`,
        params: [id, seasonId, team_id, user.userId],
      },
      ...members.map((m, i) => ({
        sql: `INSERT INTO season_team_members (id, season_id, team_id, user_id)
              VALUES (?, ?, ?, ?)`,
        params: [memberIds[i] as string, seasonId, team_id, m.user_id],
      })),
    ];

    try {
      await dbWrite.batch(statements);
    } catch (batchErr) {
      // Compensate: delete only rows created by THIS request (by UUID).
      // This is safe even under concurrent registrations because we never
      // touch rows written by other requests. Each delete is independent —
      // as one sequence, a failure of the first would skip the second and
      // leave a registered team with no roster (a 0-token leaderboard entry).
      if (memberIds.length > 0) {
        try {
          const ph = memberIds.map(() => "?").join(",");
          await dbWrite.execute(
            `DELETE FROM season_team_members WHERE id IN (${ph})`,
            memberIds
          );
        } catch {
          // Swallow cleanup errors — the original error is more important
        }
      }
      try {
        await dbWrite.execute("DELETE FROM season_teams WHERE id = ?", [id]);
      } catch {
        // Swallow cleanup errors — the original error is more important
      }
      // The registration check above is a read; two concurrent requests both
      // pass it and the loser hits UNIQUE(season_id, team_id) — or
      // UNIQUE(season_id, user_id) when two teams share a member. That is the
      // same conflict the sequential path reports as 409, not a server fault.
      if (batchErr instanceof Error && /UNIQUE constraint failed/i.test(batchErr.message)) {
        return NextResponse.json(
          { error: "Team is already registered for this season, or a member is already registered on another team" },
          { status: 409 },
        );
      }
      throw batchErr;
    }

    await dbRead.invalidateCacheKey("seasons:list");

    return NextResponse.json(
      {
        id,
        season_id: seasonId,
        team_id,
        registered_at: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) {
      return NextResponse.json(
        { error: "Season tables not yet migrated" },
        { status: 503 }
      );
    }
    console.error("Failed to register team for season:", err);
    return NextResponse.json(
      { error: "Failed to register team" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — withdraw team from season
// ---------------------------------------------------------------------------

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ seasonId: string }> }
) {
  const user = await resolveUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { seasonId } = await params;

  const parsed = await readJsonBody<{ team_id?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const { team_id } = parsed.body;
  if (!team_id || typeof team_id !== "string") {
    return NextResponse.json(
      { error: "team_id is required" },
      { status: 400 }
    );
  }

  const dbRead = await getDbRead();
  const dbWrite = await getDbWrite();

  try {
    // Verify season exists
    const season = await dbRead.getSeasonById(seasonId);

    if (!season) {
      return NextResponse.json(
        { error: "Season not found" },
        { status: 404 }
      );
    }

    const status = deriveSeasonStatus(season.start_date, season.end_date);
    if (status === "ended") {
      return NextResponse.json(
        { error: "Cannot withdraw from ended seasons" },
        { status: 400 }
      );
    }
    if (status === "active" && !season.allow_late_withdrawal) {
      return NextResponse.json(
        { error: "Withdrawal closed — season already started" },
        { status: 400 }
      );
    }

    // Verify user is team owner
    const membership = await dbRead.getTeamMembership(team_id, user.userId);

    if (!membership || membership !== "owner") {
      return NextResponse.json(
        { error: "Only team owners can withdraw from seasons" },
        { status: 403 }
      );
    }

    // Verify registration exists
    const registration = await dbRead.getSeasonRegistration(seasonId, team_id);

    if (!registration) {
      return NextResponse.json(
        { error: "Team is not registered for this season" },
        { status: 404 }
      );
    }

    // One batch: as separate statements, a failure after the roster delete
    // left the team registered with an empty roster, which the public
    // leaderboard renders as a real entry with 0 tokens until someone
    // retries. The registration delete alone is the visible-state switch, so
    // both must commit together.
    await dbWrite.batch([
      {
        sql: "DELETE FROM season_team_members WHERE season_id = ? AND team_id = ?",
        params: [seasonId, team_id],
      },
      {
        sql: "DELETE FROM season_teams WHERE season_id = ? AND team_id = ?",
        params: [seasonId, team_id],
      },
    ]);

    await dbRead.invalidateCacheKey("seasons:list");

    return NextResponse.json({ deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) {
      return NextResponse.json(
        { error: "Season tables not yet migrated" },
        { status: 503 }
      );
    }
    console.error("Failed to withdraw team from season:", err);
    return NextResponse.json(
      { error: "Failed to withdraw team" },
      { status: 500 }
    );
  }
}
