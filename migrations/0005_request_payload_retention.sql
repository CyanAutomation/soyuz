ALTER TABLE runs ADD COLUMN request_redacted_at TEXT;

CREATE INDEX runs_request_retention_idx
  ON runs(status, completed_at)
  WHERE request_redacted_at IS NULL;
