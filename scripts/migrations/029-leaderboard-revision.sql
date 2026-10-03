CREATE TABLE leaderboard_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision TEXT NOT NULL
);
INSERT INTO leaderboard_revision VALUES (1, lower(hex(randomblob(16))));

CREATE TRIGGER leaderboard_user_insert AFTER INSERT ON users BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_user_delete AFTER DELETE ON users BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_user_update
AFTER UPDATE OF id, name, nickname, image, slug, is_public ON users
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.nickname IS NOT NEW.nickname
  OR OLD.image IS NOT NEW.image OR OLD.slug IS NOT NEW.slug OR OLD.is_public IS NOT NEW.is_public
BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;

CREATE TRIGGER leaderboard_team_insert AFTER INSERT ON teams BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_delete AFTER DELETE ON teams BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_update AFTER UPDATE OF id, name, logo_url ON teams
WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.logo_url IS NOT NEW.logo_url
BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;

CREATE TRIGGER leaderboard_team_member_insert AFTER INSERT ON team_members BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_member_delete AFTER DELETE ON team_members BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_team_member_update AFTER UPDATE ON team_members BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_insert AFTER INSERT ON organization_members BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_delete AFTER DELETE ON organization_members BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER leaderboard_org_member_update AFTER UPDATE ON organization_members BEGIN
  UPDATE leaderboard_revision SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
