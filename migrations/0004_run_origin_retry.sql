DROP INDEX IF EXISTS runs_idempotency_key_uq;

ALTER TABLE runs ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'api_client';
ALTER TABLE runs ADD COLUMN origin_id TEXT NOT NULL DEFAULT 'client-api';
ALTER TABLE runs ADD COLUMN retry_of TEXT;

CREATE UNIQUE INDEX runs_idempotency_scope_uq
  ON runs(origin_type, origin_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX runs_retry_of_idx
  ON runs(retry_of)
  WHERE retry_of IS NOT NULL;
