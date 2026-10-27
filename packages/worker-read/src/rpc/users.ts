/**
 * Users domain RPC handlers.
 *
 * Provides typed query methods for user-related read operations,
 * replacing raw SQL queries with named endpoints.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type {
  CheckSharedSeasonRequest, CheckSharedTeamRequest, CheckSlugExistsRequest,
  GetPublicUserBySlugOrIdRequest, GetUserApiKeyRequest, GetUserByApiKeyRequest,
  GetUserByEmailRequest, GetUserByIdRequest, GetUserByOAuthAccountRequest,
  GetUserBySlugRequest, GetUserEmailRequest, GetUserFirstSeenRequest,
  GetUserNicknameSlugRequest, GetUserSettingsRequest, GetUserSlugOnlyRequest,
  SearchUsersRequest, SearchUsersResult, UserApiKeyAuth, UserAuth, UserProfile,
  UserSettings, UsersRpcRequest,
} from "./users-types";
export type * from "./users-types";


// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleUsersRpc(
  request: UsersRpcRequest,
  db: D1Database,
): Promise<Response> {
  switch (request.method) {
    case "users.getById":
      return handleGetUserById(request, db);
    case "users.getBySlug":
      return handleGetUserBySlug(request, db);
    case "users.getByEmail":
      return handleGetUserByEmail(request, db);
    case "users.getByApiKey":
      return handleGetUserByApiKey(request, db);
    case "users.getByOAuthAccount":
      return handleGetUserByOAuthAccount(request, db);
    case "users.checkSlugExists":
      return handleCheckSlugExists(request, db);
    case "users.getSettings":
      return handleGetUserSettings(request, db);
    case "users.getApiKey":
      return handleGetUserApiKey(request, db);
    case "users.getEmail":
      return handleGetUserEmail(request, db);
    case "users.search":
      return handleSearchUsers(request, db);
    case "users.getSlugOnly":
      return handleGetUserSlugOnly(request, db);
    case "users.getNicknameSlug":
      return handleGetUserNicknameSlug(request, db);
    case "users.checkSharedTeam":
      return handleCheckSharedTeam(request, db);
    case "users.checkSharedSeason":
      return handleCheckSharedSeason(request, db);
    case "users.getFirstSeen":
      return handleGetUserFirstSeen(request, db);
    case "users.getPublicBySlugOrId":
      return handleGetPublicUserBySlugOrId(request, db);
    default:
      return Response.json(
        { error: `Unknown users method: ${(request as { method: string }).method}` },
        { status: 400 },
      );
  }
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

async function handleGetUserById(
  req: GetUserByIdRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.id) {
    return Response.json({ error: "Missing id" }, { status: 400 });
  }

  const row = await db
    .prepare(
      "SELECT id, email, name, image, email_verified FROM users WHERE id = ?",
    )
    .bind(req.id)
    .first<UserAuth>();

  return Response.json({ result: row ?? null });
}

async function handleGetUserBySlug(
  req: GetUserBySlugRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.slug) {
    return Response.json({ error: "Missing slug" }, { status: 400 });
  }

  const row = await db
    .prepare(
      "SELECT id, name, nickname, image, slug, created_at, is_public FROM users WHERE slug = ?",
    )
    .bind(req.slug)
    .first<UserProfile>();

  return Response.json({ result: row ?? null });
}

async function handleGetUserByEmail(
  req: GetUserByEmailRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.email) {
    return Response.json({ error: "Missing email" }, { status: 400 });
  }

  const row = await db
    .prepare(
      "SELECT id, email, name, image, email_verified FROM users WHERE email = ?",
    )
    .bind(req.email)
    .first<UserAuth>();

  return Response.json({ result: row ?? null });
}

async function handleGetUserByApiKey(
  req: GetUserByApiKeyRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.apiKey) {
    return Response.json({ error: "Missing apiKey" }, { status: 400 });
  }

  const row = await db
    .prepare("SELECT id, email FROM users WHERE api_key = ?")
    .bind(req.apiKey)
    .first<UserApiKeyAuth>();

  return Response.json({ result: row ?? null });
}

async function handleGetUserByOAuthAccount(
  req: GetUserByOAuthAccountRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.provider || !req.providerAccountId) {
    return Response.json(
      { error: "Missing provider or providerAccountId" },
      { status: 400 },
    );
  }

  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.image, u.email_verified
       FROM users u
       JOIN accounts a ON u.id = a.user_id
       WHERE a.provider = ? AND a.provider_account_id = ?`,
    )
    .bind(req.provider, req.providerAccountId)
    .first<UserAuth>();

  return Response.json({ result: row ?? null });
}

async function handleCheckSlugExists(
  req: CheckSlugExistsRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.slug) {
    return Response.json({ error: "Missing slug" }, { status: 400 });
  }

  let row: { id: string } | null;
  if (req.excludeUserId) {
    row = await db
      .prepare("SELECT id FROM users WHERE slug = ? AND id != ?")
      .bind(req.slug, req.excludeUserId)
      .first<{ id: string }>();
  } else {
    row = await db
      .prepare("SELECT id FROM users WHERE slug = ?")
      .bind(req.slug)
      .first<{ id: string }>();
  }

  return Response.json({ result: { exists: row !== null } });
}

async function handleGetUserSettings(
  req: GetUserSettingsRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId) {
    return Response.json({ error: "Missing userId" }, { status: 400 });
  }

  const row = await db
    .prepare("SELECT nickname, slug, is_public FROM users WHERE id = ?")
    .bind(req.userId)
    .first<UserSettings>();

  return Response.json({ result: row ?? null });
}

async function handleGetUserApiKey(
  req: GetUserApiKeyRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId) {
    return Response.json({ error: "Missing userId" }, { status: 400 });
  }

  const row = await db
    .prepare("SELECT api_key FROM users WHERE id = ?")
    .bind(req.userId)
    .first<{ api_key: string | null }>();

  return Response.json({ result: row ?? null });
}

async function handleGetUserEmail(
  req: GetUserEmailRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId) {
    return Response.json({ error: "Missing userId" }, { status: 400 });
  }

  const row = await db
    .prepare("SELECT email FROM users WHERE id = ?")
    .bind(req.userId)
    .first<{ email: string }>();

  return Response.json({ result: row ?? null });
}

async function handleSearchUsers(
  req: SearchUsersRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.query) {
    return Response.json({ error: "Missing query" }, { status: 400 });
  }

  // Lower-clamp as well as upper: SQLite reads a negative LIMIT as "no limit".
  const limit = Math.min(Math.max(req.limit ?? 20, 0), 100);
  const pattern = `%${req.query}%`;

  const { results } = await db
    .prepare(
      `SELECT id, name, email, image FROM users
       WHERE name LIKE ? OR email LIKE ?
       ORDER BY name ASC
       LIMIT ?`,
    )
    .bind(pattern, pattern, limit)
    .all<SearchUsersResult>();

  return Response.json({ result: results ?? [] });
}

async function handleGetUserSlugOnly(
  req: GetUserSlugOnlyRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId) {
    return Response.json({ error: "Missing userId" }, { status: 400 });
  }

  const row = await db
    .prepare("SELECT slug FROM users WHERE id = ?")
    .bind(req.userId)
    .first<{ slug: string | null }>();

  return Response.json({ result: row ?? null });
}

async function handleGetUserNicknameSlug(
  req: GetUserNicknameSlugRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId) {
    return Response.json({ error: "Missing userId" }, { status: 400 });
  }

  const row = await db
    .prepare("SELECT nickname, slug FROM users WHERE id = ?")
    .bind(req.userId)
    .first<{ nickname: string | null; slug: string | null }>();

  return Response.json({ result: row ?? null });
}

async function handleCheckSharedTeam(
  req: CheckSharedTeamRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId1 || !req.userId2) {
    return Response.json({ error: "Missing userId1 or userId2" }, { status: 400 });
  }

  const row = await db
    .prepare(
      `SELECT a.team_id
       FROM team_members a
       JOIN team_members b ON a.team_id = b.team_id
       WHERE a.user_id = ? AND b.user_id = ?
       LIMIT 1`,
    )
    .bind(req.userId1, req.userId2)
    .first<{ team_id: string }>();

  return Response.json({ result: { shared: row !== null } });
}

async function handleCheckSharedSeason(
  req: CheckSharedSeasonRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId1 || !req.userId2) {
    return Response.json({ error: "Missing userId1 or userId2" }, { status: 400 });
  }

  // "Same-season participant" means the roster frozen at registration
  // (season_team_members), not live team membership: a user who joined a
  // registered team after the season locked was never a participant, and one
  // who left still was. Live membership also let anyone who joins any
  // registered team claim the same-season relationship retroactively.
  const row = await db
    .prepare(
      `SELECT stm1.season_id
       FROM season_team_members stm1
       JOIN season_team_members stm2 ON stm1.season_id = stm2.season_id
       WHERE stm1.user_id = ? AND stm2.user_id = ?
       LIMIT 1`,
    )
    .bind(req.userId1, req.userId2)
    .first<{ season_id: string }>();

  return Response.json({ result: { shared: row !== null } });
}

async function handleGetUserFirstSeen(
  req: GetUserFirstSeenRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.userId) {
    return Response.json({ error: "Missing userId" }, { status: 400 });
  }

  const row = await db
    .prepare(
      `SELECT MIN(first_seen) AS first_seen FROM (
         SELECT (
           SELECT hour_start FROM usage_records
           WHERE user_id = ? ORDER BY hour_start LIMIT 1
         ) AS first_seen
         UNION ALL
         SELECT (
           SELECT hour_start FROM usage_evidence
           WHERE user_id = ? AND total_tokens > 0 ORDER BY hour_start LIMIT 1
         )
       )`,
    )
    .bind(req.userId, req.userId)
    .first<{ first_seen: string | null }>();

  return Response.json({ result: row?.first_seen ?? null });
}

async function handleGetPublicUserBySlugOrId(
  req: GetPublicUserBySlugOrIdRequest,
  db: D1Database,
): Promise<Response> {
  if (!req.slugOrId) {
    return Response.json({ error: "Missing slugOrId" }, { status: 400 });
  }

  // Try by slug first, then by id
  let row = await db
    .prepare(
      "SELECT id, name, nickname, image, slug, created_at, is_public FROM users WHERE slug = ?",
    )
    .bind(req.slugOrId)
    .first<UserProfile>();

  if (!row) {
    row = await db
      .prepare(
        "SELECT id, name, nickname, image, slug, created_at, is_public FROM users WHERE id = ?",
      )
      .bind(req.slugOrId)
      .first<UserProfile>();
  }

  return Response.json({ result: row ?? null });
}
