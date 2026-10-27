/**
 * POST /api/organizations/[orgId]/join — join an organization.
 *
 * Requires authentication. Users can freely join any organization.
 */

import { NextResponse } from "next/server";
import { resolveUser } from "@/lib/auth-helpers";
import { unauthorizedResponse } from "@/lib/api-responses";
import { getDbRead, getDbWrite } from "@/lib/db";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const authResult = await resolveUser(request);
  if (!authResult) {
    return unauthorizedResponse();
  }

  const { orgId } = await params;
  const dbRead = await getDbRead();
  const dbWrite = await getDbWrite();

  try {
    // Verify org exists
    const org = await dbRead.getOrganizationById(orgId);

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    // Check if already a member
    const isMember = await dbRead.checkOrgMembership(orgId, authResult.userId);

    if (isMember) {
      return NextResponse.json(
        { error: "Already a member of this organization" },
        { status: 409 }
      );
    }

    // Add member. The membership predicate makes the insert idempotent under
    // concurrency: the read above is only a fast path, and two simultaneous
    // joins both pass it — the loser would otherwise hit UNIQUE(org_id,
    // user_id) as a generic 500 instead of the 409 this route promises.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const result = await dbWrite.execute(
      `INSERT INTO organization_members (id, org_id, user_id, joined_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?)`,
      [id, orgId, authResult.userId, now, orgId, authResult.userId]
    );

    if (result.changes === 0) {
      return NextResponse.json(
        { error: "Already a member of this organization" },
        { status: 409 }
      );
    }

    return NextResponse.json({
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
    }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) {
      return NextResponse.json(
        { error: "Organization tables not yet migrated" },
        { status: 503 }
      );
    }
    console.error("Failed to join organization:", err);
    return NextResponse.json(
      { error: "Failed to join organization" },
      { status: 500 }
    );
  }
}
