CREATE TABLE run_idempotency_keys (
  origin_type TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (origin_type, origin_id, idempotency_key)
);

INSERT OR IGNORE INTO run_idempotency_keys (
  origin_type, origin_id, idempotency_key, request_hash, run_id, created_at
)
SELECT origin_type, origin_id, idempotency_key, request_hash, id, created_at
FROM runs
WHERE idempotency_key IS NOT NULL;

CREATE TABLE artifact_deletion_queue (
  object_key TEXT PRIMARY KEY NOT NULL,
  queued_at TEXT NOT NULL,
  last_attempt_at TEXT
);

CREATE INDEX artifact_deletion_queue_attempt_idx
  ON artifact_deletion_queue(last_attempt_at, queued_at, object_key);
