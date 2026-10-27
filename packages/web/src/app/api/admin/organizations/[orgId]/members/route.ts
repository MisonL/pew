/**
 * GET/POST /api/admin/organizations/[orgId]/members — admin-only member management.
 *
 * - GET  → list members of the organization with user details
 * - POST → add a user to the organization
 */

import { NextResponse } from "next/server";
import { resolveAdmin } from "@/lib/admin";
import { readJsonBody } from "@/lib/request-json";
import { getDbRead, getDbWrite } from "@/lib/db";

// ---------------------------------------------------------------------------
// GET — list members
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const admin = await resolveAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { orgId } = await params;
  const dbRead = await getDbRead();

  try {
    // Verify org exists
    const org = await dbRead.getOrganizationById(orgId);

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // Get members with user details
    const results = await dbRead.listOrgMembersAdmin(orgId);

    const members = results.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      userId: r.user_id,
      joinedAt: r.joined_at,
      user: {
        id: r.user_id,
        name: r.name,
        email: r.email,
        image: r.image,
        slug: r.slug,
      },
    }));

    return NextResponse.json({ members });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) {
      return NextResponse.json(
        { error: "Organization tables not yet migrated" },
        { status: 503 }
      );
    }
    console.error("Failed to list organization members:", err);
    return NextResponse.json(
      { error: "Failed to list members" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST — add member
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const admin = await resolveAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { orgId } = await params;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { userId } = parsed.body as { userId?: string };

  if (!userId || typeof userId !== "string") {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400 }
    );
  }

  const dbRead = await getDbRead();
  const dbWrite = await getDbWrite();

  try {
    // Verify org exists
    const org = await dbRead.getOrganizationById(orgId);

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // Verify user exists
    const [user] = await dbRead.getAdminUsersByIds([userId]);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if already a member
    const existing = await dbRead.checkOrgMembership(orgId, userId);

    if (existing) {
      return NextResponse.json(
        { error: "User is already a member of this organization" },
        { status: 409 }
      );
    }

    // Add member. Same idempotent-insert rule as the user-facing join route:
    // the read above is a fast path, and two concurrent adds both pass it —
    // the loser would hit UNIQUE(org_id, user_id) as a generic 500.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const added = await dbWrite.execute(
      `INSERT INTO organization_members (id, org_id, user_id, joined_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?)`,
      [id, orgId, userId, now, orgId, userId]
    );

    if (added.changes === 0) {
      return NextResponse.json(
        { error: "User is already a member of this organization" },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        id,
        orgId,
        userId,
        joinedAt: now,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          slug: user.slug,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) {
      return NextResponse.json(
        { error: "Organization tables not yet migrated" },
        { status: 503 }
      );
    }
    console.error("Failed to add organization member:", err);
    return NextResponse.json(
      { error: "Failed to add member" },
      { status: 500 }
    );
  }
}
