/**
 * Season roster sync — synchronizes team_members → season_team_members
 * for active seasons with `allow_roster_changes = 1`.
 *
 * Called after team membership changes (join, kick, leave) to keep
 * frozen season rosters in sync when the admin has opted in.
 *
 * Also provides `syncAllRostersForSeason()` for admin-triggered bulk
 * backfill (e.g. when `allow_roster_changes` is toggled on).
 */

import type { DbRead, DbWrite } from "@/lib/db";

/**
 * Re-offer a freed season seat to the user's other registered team.
 *
 * UNIQUE(season_id, user_id) lets one roster hold a user, so a join into a
 * second registered team is silently ignored while the first team holds their
 * seat. When that team releases it — a member leaves, is kicked, or the owner
 * withdraws the team from the season — nothing revisited the other teams, and
 * the user ended up on no roster at all: their season usage stopped counting
 * until an unrelated membership change happened to re-sync it. This puts the
 * seat back on exactly one eligible team, only when the user currently holds
 * no seat in that season.
 *
 * One statement serves all three call sites; the two optional scopes are
 * `COALESCE(?, column) = column` (a NULL scope matches every row):
 *
 *   - user scope: NULL for the leave route, which re-offers for one user but
 *     does not know which seasons its release statement touched, and a single
 *     id when syncing one team or withdrawing one team's roster.
 *   - season scope: NULL where the seasons are discovered by the statement
 *     itself, and the season id when the caller already knows it.
 *
 * UNIQUE(season_id, user_id) keeps it to one row per season, so
 * `ORDER BY st.team_id` decides which team wins when several qualify.
 *
 * The row id comes from `hex(randomblob(16))` rather than a bound argument:
 * a single argument would give every row the same id, and OR IGNORE would
 * then drop all but the first on the primary key.
 *
 * Params: [user_id or null, season_id or null, the team that released the
 * seat].
 */
export function seasonSeatReassignmentSql(): string {
  return `INSERT OR IGNORE INTO season_team_members (id, season_id, team_id, user_id)
           SELECT hex(randomblob(16)), st.season_id, st.team_id, tm.user_id
           FROM season_teams st
           JOIN teams t ON t.id = st.team_id
           JOIN team_members tm ON tm.team_id = st.team_id
           JOIN seasons s ON s.id = st.season_id
           WHERE COALESCE(?, tm.user_id) = tm.user_id
             AND COALESCE(?, st.season_id) = st.season_id
             AND st.team_id != ?
             AND s.allow_roster_changes = 1
             AND datetime(s.start_date) <= datetime('now')
             AND datetime(s.end_date, '+1 minute') > datetime('now')
             AND NOT EXISTS (
               SELECT 1 FROM season_team_members ex
               WHERE ex.season_id = st.season_id AND ex.user_id = tm.user_id
             )
           ORDER BY st.season_id, st.team_id`;
}

/**
 * Sync season rosters for a given team.
 *
 * For each active season where the team is registered AND
 * `allow_roster_changes = 1`:
 *   - INSERT OR IGNORE new members (handles UNIQUE(season_id, user_id))
 *   - DELETE members who left the team
 */
export async function syncSeasonRosters(
  dbRead: DbRead,
  dbWrite: DbWrite,
  teamId: string,
): Promise<void> {
  // Find active seasons this team is registered for with roster changes enabled
  const seasons = await dbRead.listRosterSyncSeasons(teamId);

  if (seasons.length === 0) return;

  // Get current team members
  const currentMembers = await dbRead.getTeamMemberUserIds(teamId);

  const currentUserIds = new Set(currentMembers);

  for (const season_id of seasons) {
    // Get existing season roster for this team
    const seasonMembers = await dbRead.getRosterUserIds(season_id, teamId);

    const seasonUserIds = new Set(seasonMembers);

    // Add new members (INSERT OR IGNORE handles UNIQUE(season_id, user_id) conflicts
    // where a user is already registered on another team)
    for (const userId of currentUserIds) {
      if (!seasonUserIds.has(userId)) {
        await dbWrite.execute(
          `INSERT OR IGNORE INTO season_team_members (id, season_id, team_id, user_id)
           VALUES (?, ?, ?, ?)`,
          [crypto.randomUUID(), season_id, teamId, userId],
        );
      }
    }

    // Remove departed members
    for (const userId of seasonUserIds) {
      if (!currentUserIds.has(userId)) {
        await dbWrite.execute(
          "DELETE FROM season_team_members WHERE season_id = ? AND team_id = ? AND user_id = ?",
          [season_id, teamId, userId],
        );
        // The freed seat goes back to another of this user's registered
        // teams (see seasonSeatReassignmentSql).
        await dbWrite.execute(
          seasonSeatReassignmentSql(),
          [userId, season_id, teamId],
        );
      }
    }
  }
}

/**
 * Sync rosters for ALL registered teams in a given season.
 *
 * Unlike `syncSeasonRosters` (which is event-driven per-team), this
 * function is intended for admin-triggered bulk backfill — e.g. when
 * `allow_roster_changes` is toggled on and members who joined while
 * the toggle was off need to be added retroactively.
 *
 * No `allow_roster_changes` guard — the caller decides when it's appropriate.
 *
 * Returns the number of teams that were synced.
 */
export async function syncAllRostersForSeason(
  dbRead: DbRead,
  dbWrite: DbWrite,
  seasonId: string,
): Promise<number> {
  // Get all teams registered for this season
  const teams = await dbRead.getRegisteredTeamIds(seasonId);

  if (teams.length === 0) return 0;

  for (const team_id of teams) {
    // Get current team members
    const currentMembers = await dbRead.getTeamMemberUserIds(team_id);

    const currentUserIds = new Set(currentMembers);

    // Get existing season roster for this team
    const seasonMembers = await dbRead.getRosterUserIds(seasonId, team_id);

    const seasonUserIds = new Set(seasonMembers);

    // Add missing members
    for (const userId of currentUserIds) {
      if (!seasonUserIds.has(userId)) {
        await dbWrite.execute(
          `INSERT OR IGNORE INTO season_team_members (id, season_id, team_id, user_id)
           VALUES (?, ?, ?, ?)`,
          [crypto.randomUUID(), seasonId, team_id, userId],
        );
      }
    }

    // Remove departed members
    for (const userId of seasonUserIds) {
      if (!currentUserIds.has(userId)) {
        await dbWrite.execute(
          "DELETE FROM season_team_members WHERE season_id = ? AND team_id = ? AND user_id = ?",
          [seasonId, team_id, userId],
        );
      }
    }
  }

  return teams.length;
}
