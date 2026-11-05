import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDbRead } from "@/lib/db";
import { PublicProfileView } from "./profile-view";

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

  const db = await getDbRead();

  // Look up user by slug or id
  const user = await db.getPublicUserBySlugOrId(slug);

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

  // The client view fetches the profile itself, so without this the page
  // answered 200 for anyone — a soft 404 that search engines index and that
  // hides the distinction between "no such user" and "private profile".
  const db = await getDbRead();
  const user = await db.getPublicUserBySlugOrId(slug);
  if (!user) notFound();

  return <PublicProfileView slug={slug} />;
}
