CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('log', 'patch', 'report', 'other')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 25000000),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready'))
);

CREATE INDEX IF NOT EXISTS run_artifacts_run_created_idx
  ON run_artifacts(run_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS run_artifacts_expiration_idx
  ON run_artifacts(expires_at);

CREATE TRIGGER IF NOT EXISTS run_artifacts_limit_per_run
BEFORE INSERT ON run_artifacts
WHEN (
  SELECT COUNT(*) FROM run_artifacts
  WHERE run_id = NEW.run_id AND expires_at > NEW.created_at
) >= 100
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_LIMIT_REACHED');
END;
