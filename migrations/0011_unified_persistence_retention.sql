-- Additive, executor independent persistence metadata. Existing API contract v1
-- remains unchanged; these values version the records stored by Soyuz.
ALTER TABLE runs ADD COLUMN persistence_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (persistence_schema_version = 1);
ALTER TABLE runs ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
ALTER TABLE runs ADD COLUMN expires_at TEXT;
ALTER TABLE runs ADD COLUMN artifact_delivery_status TEXT NOT NULL DEFAULT 'not_reported'
  CHECK (artifact_delivery_status IN ('not_reported', 'complete', 'partial', 'failed'));

UPDATE runs
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days');
CREATE INDEX runs_expiration_idx ON runs(expires_at, id);

ALTER TABLE run_events ADD COLUMN event_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (event_schema_version = 1);
ALTER TABLE run_events ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
ALTER TABLE run_events ADD COLUMN producer_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE run_events ADD COLUMN expires_at TEXT;
UPDATE run_events
SET expires_at = (SELECT expires_at FROM runs WHERE runs.id = run_events.run_id);
CREATE INDEX run_events_expiration_idx ON run_events(expires_at, sequence);

ALTER TABLE run_artifacts ADD COLUMN artifact_type TEXT NOT NULL DEFAULT 'execution.other';
ALTER TABLE run_artifacts ADD COLUMN artifact_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (artifact_schema_version = 1);
ALTER TABLE run_artifacts ADD COLUMN content_encoding TEXT NOT NULL DEFAULT 'identity';
ALTER TABLE run_artifacts ADD COLUMN sha256 TEXT;
ALTER TABLE run_artifacts ADD COLUMN producer_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE run_artifacts ADD COLUMN engine_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE run_artifacts ADD COLUMN engine_version TEXT;
ALTER TABLE run_artifacts ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
ALTER TABLE run_artifacts ADD COLUMN object_status TEXT NOT NULL DEFAULT 'present' CHECK (object_status IN ('present', 'missing'));
UPDATE run_artifacts
SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE runs.id = run_artifacts.run_id),
                          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days')),
    artifact_type = CASE name
      WHEN 'result-summary.md' THEN 'execution.summary'
      WHEN 'failure.json' THEN 'execution.failure'
      WHEN 'git.diff' THEN 'code.diff'
      WHEN 'changed-files.txt' THEN 'code.changed-files'
      WHEN 'run-scorecard.json' THEN 'evaluation.scorecard'
      WHEN 'run-evaluation.json' THEN 'evaluation.result'
      WHEN 'publication-manifest.json' THEN 'publication.manifest'
      WHEN 'validation.json' THEN 'validation.result'
      ELSE CASE kind WHEN 'log' THEN 'execution.log' WHEN 'patch' THEN 'code.patch'
                     WHEN 'report' THEN 'execution.report' ELSE 'execution.other' END
    END,
    producer_id = COALESCE((SELECT worker_id FROM runs WHERE runs.id = run_artifacts.run_id), 'legacy');
CREATE INDEX run_artifacts_run_expiration_idx ON run_artifacts(run_id, expires_at, id);

CREATE TRIGGER run_artifacts_aggregate_limit_insert
BEFORE INSERT ON run_artifacts
WHEN COALESCE((SELECT SUM(size_bytes) FROM run_artifacts WHERE run_id = NEW.run_id), 0) + NEW.size_bytes > 100000000
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AGGREGATE_LIMIT_REACHED');
END;

CREATE TRIGGER run_artifacts_aggregate_limit_update
BEFORE UPDATE OF size_bytes, run_id ON run_artifacts
WHEN COALESCE((SELECT SUM(size_bytes) FROM run_artifacts WHERE run_id = NEW.run_id AND id != OLD.id), 0) + NEW.size_bytes > 100000000
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_AGGREGATE_LIMIT_REACHED');
END;

ALTER TABLE run_idempotency_keys ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
ALTER TABLE run_idempotency_keys ADD COLUMN expires_at TEXT;
UPDATE run_idempotency_keys
SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE runs.id = run_idempotency_keys.run_id),
                          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days'));
CREATE INDEX run_idempotency_expiration_idx ON run_idempotency_keys(expires_at, origin_type, origin_id);

ALTER TABLE publication_manifest_artifacts ADD COLUMN artifact_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (artifact_schema_version = 1);
ALTER TABLE publication_manifest_artifacts ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
UPDATE publication_manifest_artifacts
SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE runs.id = publication_manifest_artifacts.run_id),
                          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days'));

ALTER TABLE publication_intents ADD COLUMN persistence_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (persistence_schema_version = 1);
ALTER TABLE publication_intents ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
ALTER TABLE publication_intents ADD COLUMN expires_at TEXT;
UPDATE publication_intents
SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE runs.id = publication_intents.run_id),
                          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days')),
    retained_until = CASE WHEN retained_until IS NULL THEN NULL
                          WHEN retained_until > COALESCE((SELECT expires_at FROM runs WHERE runs.id = publication_intents.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days'))
                          THEN COALESCE((SELECT expires_at FROM runs WHERE runs.id = publication_intents.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days')) ELSE retained_until END;
CREATE INDEX publication_intents_expiration_idx ON publication_intents(expires_at, publication_id);

ALTER TABLE publications ADD COLUMN persistence_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (persistence_schema_version = 1);
ALTER TABLE publications ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
ALTER TABLE publications ADD COLUMN expires_at TEXT;
UPDATE publications
SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE runs.id = publications.run_id),
                          strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days')),
    retained_until = CASE WHEN retained_until IS NULL THEN NULL
                          WHEN retained_until > COALESCE((SELECT expires_at FROM runs WHERE runs.id = publications.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days'))
                          THEN COALESCE((SELECT expires_at FROM runs WHERE runs.id = publications.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days')) ELSE retained_until END;
CREATE INDEX publications_expiration_idx ON publications(expires_at, publication_id);

ALTER TABLE publication_events ADD COLUMN event_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (event_schema_version = 1);
ALTER TABLE publication_events ADD COLUMN retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1);
ALTER TABLE publication_events ADD COLUMN expires_at TEXT;
UPDATE publication_events
SET expires_at = COALESCE((SELECT expires_at FROM publications WHERE publications.publication_id = publication_events.publication_id),
                          strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+90 days'));
CREATE INDEX publication_events_expiration_idx ON publication_events(expires_at, sequence);

CREATE TABLE artifact_reconciliation_state (
  reconciliation_id TEXT PRIMARY KEY NOT NULL,
  cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1)
);
CREATE INDEX artifact_reconciliation_state_expiration_idx ON artifact_reconciliation_state(expires_at);

CREATE TABLE artifact_reconciliation_metrics (
  metric_day TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('orphan_object', 'missing_object', 'reconciliation_error', 'cleanup_failure')),
  count INTEGER NOT NULL CHECK (count >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1),
  PRIMARY KEY (metric_day, outcome)
);
CREATE INDEX artifact_reconciliation_metrics_expiration_idx ON artifact_reconciliation_metrics(expires_at, metric_day);

CREATE TABLE artifact_upload_metrics (
  metric_day TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('rejected', 'stored')),
  code TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retention_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (retention_policy_version = 1),
  PRIMARY KEY (metric_day, outcome, code)
);
CREATE INDEX artifact_upload_metrics_expiration_idx ON artifact_upload_metrics(expires_at, metric_day);

CREATE TRIGGER runs_expiry_on_insert
AFTER INSERT ON runs
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE runs SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days') WHERE id = NEW.id;
END;

CREATE TRIGGER runs_expiry_is_canonical
BEFORE UPDATE OF expires_at ON runs
WHEN NEW.expires_at != strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days')
BEGIN
  SELECT RAISE(ABORT, 'RUN_EXPIRY_MUST_USE_CANONICAL_CREATION_TIME');
END;

CREATE TRIGGER run_events_expiry_on_insert
AFTER INSERT ON run_events
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE run_events SET expires_at = (SELECT expires_at FROM runs WHERE id = NEW.run_id)
  WHERE sequence = NEW.sequence;
END;

CREATE TRIGGER run_events_reject_expired_insert
BEFORE INSERT ON run_events
WHEN (SELECT expires_at FROM runs WHERE id = NEW.run_id) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'RUN_RETENTION_EXPIRED');
END;

CREATE TRIGGER run_artifacts_expiry_on_insert
AFTER INSERT ON run_artifacts
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE run_artifacts SET expires_at = (SELECT expires_at FROM runs WHERE id = NEW.run_id) WHERE id = NEW.id;
END;

CREATE TRIGGER run_artifacts_reject_expired_insert
BEFORE INSERT ON run_artifacts
WHEN (SELECT expires_at FROM runs WHERE id = NEW.run_id) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'RUN_RETENTION_EXPIRED');
END;

CREATE TRIGGER runs_reject_expired_update
BEFORE UPDATE ON runs
WHEN OLD.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'RUN_RETENTION_EXPIRED');
END;

CREATE TRIGGER runs_reject_expired_event_stream
BEFORE INSERT ON run_events
WHEN (SELECT COUNT(*) FROM run_events WHERE run_id = NEW.run_id) >= 2000
  AND NEW.type NOT IN ('run.completed', 'run.failed', 'run.cancelled', 'run.admission_failed')
BEGIN
  SELECT RAISE(ABORT, 'RUN_EVENT_LIMIT_REACHED');
END;

CREATE TRIGGER run_events_payload_size_insert
BEFORE INSERT ON run_events
WHEN length(CAST(NEW.payload_json AS BLOB)) > 12288
BEGIN
  SELECT RAISE(ABORT, 'RUN_EVENT_PAYLOAD_TOO_LARGE');
END;

CREATE TRIGGER run_events_payload_size_update
BEFORE UPDATE OF payload_json ON run_events
WHEN length(CAST(NEW.payload_json AS BLOB)) > 12288
BEGIN
  SELECT RAISE(ABORT, 'RUN_EVENT_PAYLOAD_TOO_LARGE');
END;

CREATE TRIGGER run_idempotency_expiry_on_insert
AFTER INSERT ON run_idempotency_keys
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE run_idempotency_keys
  SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
  WHERE origin_type = NEW.origin_type AND origin_id = NEW.origin_id AND idempotency_key = NEW.idempotency_key;
END;

CREATE TRIGGER publication_manifest_expiry_on_insert
AFTER INSERT ON publication_manifest_artifacts
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE publication_manifest_artifacts
  SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
  WHERE artifact_id = NEW.artifact_id;
END;

CREATE TRIGGER publication_intent_expiry_on_insert
AFTER INSERT ON publication_intents
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE publication_intents
  SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days')),
      retained_until = CASE WHEN retained_until IS NULL THEN NULL
        WHEN retained_until > COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
          strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
        THEN COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
          strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days')) ELSE retained_until END
  WHERE publication_id = NEW.publication_id;
END;

CREATE TRIGGER publication_expiry_on_insert
AFTER INSERT ON publications
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE publications
  SET expires_at = COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days')),
      retained_until = CASE WHEN retained_until IS NULL THEN NULL
        WHEN retained_until > COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
          strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
        THEN COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
          strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days')) ELSE retained_until END
  WHERE publication_id = NEW.publication_id;
END;

CREATE TRIGGER publication_event_expiry_on_insert
AFTER INSERT ON publication_events
WHEN NEW.expires_at IS NULL
BEGIN
  UPDATE publication_events
  SET expires_at = COALESCE((SELECT expires_at FROM publications WHERE publication_id = NEW.publication_id),
                            strftime('%Y-%m-%dT%H:%M:%fZ', NEW.occurred_at, '+90 days'))
  WHERE sequence = NEW.sequence;
END;

CREATE TRIGGER publications_reject_expired_update
BEFORE UPDATE ON publications
WHEN OLD.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'PUBLICATION_RETENTION_EXPIRED');
END;

CREATE TRIGGER publications_reject_expired_event
BEFORE INSERT ON publication_events
WHEN COALESCE((SELECT expires_at FROM publications WHERE publication_id = NEW.publication_id),
              (SELECT expires_at FROM publication_intents WHERE publication_id = NEW.publication_id))
     <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'PUBLICATION_RETENTION_EXPIRED');
END;

CREATE TRIGGER runs_creation_timestamp_is_immutable
BEFORE UPDATE OF created_at ON runs
WHEN NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'RUN_CREATION_TIMESTAMP_IMMUTABLE');
END;

CREATE TRIGGER run_events_expiry_cannot_extend
BEFORE UPDATE OF expires_at ON run_events
WHEN NEW.expires_at > (SELECT expires_at FROM runs WHERE id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'RUN_EXPIRY_CANNOT_BE_EXTENDED');
END;

CREATE TRIGGER run_artifacts_expiry_cannot_extend
BEFORE UPDATE OF expires_at ON run_artifacts
WHEN NEW.expires_at > (SELECT expires_at FROM runs WHERE id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'RUN_EXPIRY_CANNOT_BE_EXTENDED');
END;

CREATE TRIGGER idempotency_expiry_cannot_extend
BEFORE UPDATE OF expires_at ON run_idempotency_keys
WHEN NEW.expires_at > COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                               strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
BEGIN
  SELECT RAISE(ABORT, 'RUN_EXPIRY_CANNOT_BE_EXTENDED');
END;

CREATE TRIGGER publication_manifest_expiry_cannot_extend
BEFORE UPDATE OF expires_at ON publication_manifest_artifacts
WHEN NEW.expires_at > COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                               strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
BEGIN
  SELECT RAISE(ABORT, 'RUN_EXPIRY_CANNOT_BE_EXTENDED');
END;

CREATE TRIGGER publication_intent_expiry_cannot_extend
BEFORE UPDATE OF expires_at, retained_until ON publication_intents
WHEN NEW.expires_at > COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                               strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
  OR (NEW.retained_until IS NOT NULL AND NEW.retained_until > NEW.expires_at)
BEGIN
  SELECT RAISE(ABORT, 'PUBLICATION_EXPIRY_CANNOT_BE_EXTENDED');
END;

CREATE TRIGGER publication_expiry_cannot_extend
BEFORE UPDATE OF expires_at, retained_until ON publications
WHEN NEW.expires_at > COALESCE((SELECT expires_at FROM runs WHERE id = NEW.run_id),
                               strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days'))
  OR (NEW.retained_until IS NOT NULL AND NEW.retained_until > NEW.expires_at)
BEGIN
  SELECT RAISE(ABORT, 'PUBLICATION_EXPIRY_CANNOT_BE_EXTENDED');
END;

CREATE TRIGGER artifact_upload_metric_expiry_on_insert
AFTER INSERT ON artifact_upload_metrics
WHEN NEW.expires_at IS NULL OR NEW.expires_at = ''
BEGIN
  UPDATE artifact_upload_metrics
  SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+90 days')
  WHERE metric_day = NEW.metric_day AND outcome = NEW.outcome AND code = NEW.code;
END;

CREATE TRIGGER run_events_artifact_delivery_status
AFTER INSERT ON run_events
WHEN NEW.type = 'artifacts.uploaded'
BEGIN
  UPDATE runs
  SET artifact_delivery_status = CASE json_extract(NEW.payload_json, '$.status')
    WHEN 'complete' THEN 'complete'
    WHEN 'partial' THEN 'partial'
    WHEN 'failed' THEN 'failed'
    ELSE artifact_delivery_status END
  WHERE id = NEW.run_id AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;
