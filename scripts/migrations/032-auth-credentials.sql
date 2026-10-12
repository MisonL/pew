-- Credentials (email + password) auth support.
--
-- users has no password/role column upstream; password_hash feeds the
-- Credentials provider (lib/credentials.ts), is_admin backs the "first user
-- is admin" rule (lib/admin.ts reads it).
--
-- instance_setup is a single-row claim table: the first /setup request inserts
-- its row in the same transaction that creates the admin, so a concurrent
-- second request fails on the PRIMARY KEY collision. That closes the
-- "no users => no invite codes => no users" deadlock without any pre-seed
-- script. See spec §4.4.

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS instance_setup (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  admin_user_id TEXT NOT NULL,
  completed_at  TEXT NOT NULL
);

-- Admin-initiated password reset (§4.4): no email capability exists, so the
-- admin generates a single-use token and hands it over out of band.
CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
