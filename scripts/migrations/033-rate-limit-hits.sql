-- Sliding-window hit log for the rqlite-backed login rate limiter (Plan 3 §3.2).
-- Rows are bounded by the limiter's table-level cleanup constant (3600s window).
--
-- This file is pure DDL, so it runs through the rewrite path that appends
-- ?norwtime&norwrandom (see Task 5: DDL must carry it): rqlite replicates
-- statements, not effects, and time()/random() here would diverge replicas.
-- Neither appears in the statements below, but the flag keeps the executor's
-- contract uniform for plan migrations.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key    TEXT NOT NULL,
  hit_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_key_at ON rate_limit_hits(key, hit_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_at ON rate_limit_hits(hit_at);
