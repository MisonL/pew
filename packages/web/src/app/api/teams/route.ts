/**
 * GET /api/teams — list teams the current user belongs to.
 * POST /api/teams — create a new team.
 *
 * Admins see all teams on GET.
 */

import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth-helpers";
import { isAdminUser } from "@/lib/admin";
import { getDbRead, getDbWrite } from "@/lib/db";
import { readJsonBody } from "@/lib/request-json";
import type { TeamRow } from "@/lib/rpc-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip invite_code from team data unless the requesting user is the creator or admin. */
function sanitizeTeamForMember(
  team: TeamRow,
  userId: string,
  isAdmin: boolean,
): Omit<TeamRow, "invite_code"> | TeamRow {
  if (isAdmin || team.created_by === userId) return team;
  const { invite_code: _, ...rest } = team;
  return rest;
}

// ---------------------------------------------------------------------------
// GET — list user's teams
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const authResult = await resolveUser(request);
  if (!authResult) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const dbRead = await getDbRead();
    const isAdmin = await isAdminUser(authResult);

    // Admins see all teams, regular users see only their memberships
    const teams = isAdmin
      ? await dbRead.listAllTeams()
      : await dbRead.listTeamsForUser(authResult.userId);

    return NextResponse.json(
      {
        teams: teams.map((t) => {
          const { logo_url, ...sanitized } = sanitizeTeamForMember(t, authResult.userId, isAdmin);
          return {
            ...sanitized,
            logoUrl: logo_url ?? null,
          };
        }),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    // Gracefully degrade if teams table doesn't exist yet
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) {
      return NextResponse.json({ teams: [] });
    }
    console.error("Failed to query teams:", err);
    return NextResponse.json({ error: "Failed to load teams" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — create a new team
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const authResult = await resolveUser(request);
  if (!authResult) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const name = body.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    return NextResponse.json(
      { error: "name must be 1-64 characters" },
      { status: 400 },
    );
  }

  // Auto-generate slug from name
  const baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

  const slug = baseSlug || "team";

  try {
    const dbRead = await getDbRead();
    const dbWrite = await getDbWrite();

    // Ensure unique slug
    const existing = await dbRead.checkTeamSlugExists(slug);

    const finalSlug = existing
      ? `${slug}-${crypto.randomUUID().slice(0, 6)}`
      : slug;

    // Generate invite code — 128 bits of entropy (32 hex chars)
    const inviteCode = randomBytes(16).toString("hex");

    const teamId = crypto.randomUUID();

    // One batch: a team row whose owner membership insert failed would be
    // invisible to listTeamsForUser (INNER JOIN team_members) yet still hold a
    // live invite_code, and no route could delete it. The slug uniqueness
    // check above is a read, so a concurrent create can still win the race —
    // that surfaces as UNIQUE constraint failed and is mapped to 409 below.
    await dbWrite.batch([
      {
        sql: `INSERT INTO teams (id, name, slug, invite_code, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        params: [teamId, name, finalSlug, inviteCode, authResult.userId],
      },
      {
        sql: `INSERT INTO team_members (id, team_id, user_id, role, joined_at)
         VALUES (?, ?, ?, 'owner', datetime('now'))`,
        params: [crypto.randomUUID(), teamId, authResult.userId],
      },
    ]);

    return NextResponse.json({
      id: teamId,
      name,
      slug: finalSlug,
      invite_code: inviteCode,
      member_count: 1,
      logoUrl: null,
    }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) {
      return NextResponse.json(
        { error: "Teams feature not available yet — database migration pending" },
        { status: 503 },
      );
    }
    if (/UNIQUE constraint failed/i.test(msg) && /teams\.slug/i.test(msg)) {
      return NextResponse.json(
        { error: "A team with this name already exists. Please try a different name." },
        { status: 409 },
      );
    }
    console.error("Failed to create team:", err);
    return NextResponse.json({ error: "Failed to create team" }, { status: 500 });
  }
}
