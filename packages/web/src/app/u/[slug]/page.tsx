import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getDbRead } from "@/lib/db";
import { resolveSessionUser } from "@/lib/auth-helpers";
import { canBypassPublic } from "@/lib/profile-access";
import { PublicProfileView } from "./profile-view";

// generateMetadata and the page both need the same row; cache() keeps it to one
// query per request.
const loadPublicUser = cache(async (slug: string) => {
  const db = await getDbRead();
  return db.getPublicUserBySlugOrId(slug);
});

// ---------------------------------------------------------------------------
// Dynamic metadata for SEO / social sharing
// ---------------------------------------------------------------------------

const GENERIC_METADATA: Metadata = {
  title: "Profile — pew",
  description: "Public profile on pew",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const user = await loadPublicUser(slug);

  // If user not found or not public, return generic metadata (don't leak name)
  if (!user?.is_public) {
    return GENERIC_METADATA;
  }

  const displayName = user.name ?? user.slug ?? slug;

  return {
    title: `${displayName} — pew`,
    description: `See how ${displayName} wields AI`,
    openGraph: {
      title: `${displayName} — pew`,
      description: `See how ${displayName} wields AI`,
    },
  };
}

// ---------------------------------------------------------------------------
// Page (Server Component shell → Client Component body)
// ---------------------------------------------------------------------------

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Same visibility rule as GET /api/users/[slug]. Checking only for a missing
  // row answered 200 for private profiles — a soft 404 that search engines
  // index and that tells anyone whether an account exists.
  const user = await loadPublicUser(slug);
  if (!user) notFound();
  if (!user.is_public) {
    const viewer = await resolveSessionUser();
    if (!viewer) notFound();
    const db = await getDbRead();
    if (!(await canBypassPublic(viewer, db, user.id))) notFound();
  }

  return <PublicProfileView slug={slug} />;
}
