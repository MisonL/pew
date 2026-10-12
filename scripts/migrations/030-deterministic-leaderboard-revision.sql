-- Make leaderboard revision generation deterministic.
--
-- 029 uses lower(hex(randomblob(16))) inside trigger bodies. rqlite replicates
-- statements, not effects: each replica re-evaluates randomblob() when it
-- applies the trigger, so replicas diverge (measured: three replicas produced
-- three different revisions after a paused follower replayed the log). A
-- counter replayed from the same log converges on every replica.
--
-- printf('%032x', n) keeps the 32-lowercase-hex shape that
-- leaderboard-snapshot.ts validates with /^[a-f0-9]{32}$/.
--
-- Semantics change from "random" to "monotonic". Every consumer only tests
-- equality (leaderboard-snapshot.ts:135,143 and api/leaderboard/route.ts:185),
-- so monotonicity is compatible.

CREATE TABLE IF NOT EXISTS leaderboard_revision_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);
INSERT OR IGNORE INTO leaderboard_revision_seq (id, n) VALUES (1, 0);

-- 029 seeds leaderboard_revision with lower(hex(randomblob(16))). That DML
-- runs through the default rewrite path (see Task 5: DML must NOT carry
-- ?norwtime&norwrandom), so every replica stores the same literal — but the
-- value is still a random blob, not a counter. Overwrite it here so the
-- revision starts at a deterministic 0 and only ever moves via the triggers
-- below. Without this, a read-only instance would keep the random seed.
UPDATE leaderboard_revision SET revision = printf('%032x', 0) WHERE id = 1;

DROP TRIGGER IF EXISTS leaderboard_user_insert;
DROP TRIGGER IF EXISTS leaderboard_user_delete;
DROP TRIGGER IF EXISTS leaderboard_user_update;
DROP TRIGGER IF EXISTS leaderboard_team_insert;
DROP TRIGGER IF EXISTS leaderboard_team_delete;
DROP TRIGGER IF EXISTS leaderboard_team_update;
DROP TRIGGER IF EXISTS leaderboard_team_member_insert;
DROP TRIGGER IF EXISTS leaderboard_team_member_delete;
DROP TRIGGER IF EXISTS leaderboard_team_member_update;
DROP TRIGGER IF EXISTS leaderboard_org_member_insert;
DROP TRIGGER IF EXISTS leaderboard_org_member_delete;
DROP TRIGGER IF EXISTS leaderboard_org_member_update;

CREATE TRIGGER leaderboard_user_insert AFTER INSERT ON users BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_user_delete AFTER DELETE ON users BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_user_update
AFTER UPDATE OF id, name, nickname, image, slug, is_public ON users
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.nickname IS NOT NEW.nickname
  OR OLD.image IS NOT NEW.image OR OLD.slug IS NOT NEW.slug OR OLD.is_public IS NOT NEW.is_public
BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;

CREATE TRIGGER leaderboard_team_insert AFTER INSERT ON teams BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_delete AFTER DELETE ON teams BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_update AFTER UPDATE OF id, name, logo_url ON teams
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.logo_url IS NOT NEW.logo_url
BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;

CREATE TRIGGER leaderboard_team_member_insert AFTER INSERT ON team_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_member_delete AFTER DELETE ON team_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_member_update AFTER UPDATE ON team_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_insert AFTER INSERT ON organization_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_delete AFTER DELETE ON organization_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_update AFTER UPDATE ON organization_members BEGIN
  UPDATE leaderboard_revision_seq SET n = n + 1 WHERE id = 1;
  UPDATE leaderboard_revision SET revision = printf('%032x', (SELECT n FROM leaderboard_revision_seq WHERE id = 1)) WHERE id = 1;
END;
