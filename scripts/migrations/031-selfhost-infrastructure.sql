-- Self-hosted deployment infrastructure.
--
-- worker-read uses env.CACHE as a Cloudflare KV namespace. In the self-hosted
-- deployment that binding is backed by this table (deploy/selfhost/kv-adapter.ts),
-- so every read replica shares one cache and the cache is included in the
-- rqlite backup. Nothing upstream creates this table — without it every cache
-- read and write in worker-read fails.
--
-- expires_at holds an absolute ISO-8601 timestamp; kv-adapter filters on it at
-- read time and treats NULL as "never expires".

CREATE TABLE IF NOT EXISTS kv_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_kv_cache_expires ON kv_cache(expires_at);
