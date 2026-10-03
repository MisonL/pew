CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_records(hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_source_time ON usage_records(source, hour_start);
CREATE INDEX IF NOT EXISTS idx_evidence_time ON usage_evidence(hour_start);
CREATE INDEX IF NOT EXISTS idx_evidence_source_time ON usage_evidence(source, hour_start);
