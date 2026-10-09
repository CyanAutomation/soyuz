ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE runs ADD COLUMN operational_health TEXT NOT NULL DEFAULT 'unknown'
  CHECK (operational_health IN ('unknown', 'healthy', 'suspect_stalled'));

CREATE INDEX IF NOT EXISTS runs_active_liveness_idx
  ON runs(status, operational_health, last_heartbeat_at, started_at);
