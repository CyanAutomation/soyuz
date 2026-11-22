-- Publication data is deliberately independent of runs: run history may be culled
-- while an authorized publication still needs its immutable manifest.
CREATE TABLE publication_manifest_artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 9437184),
  object_key TEXT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  claim_callback_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX publication_manifest_expiration_idx
  ON publication_manifest_artifacts(expires_at, artifact_id);

CREATE TABLE publication_intents (
  publication_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  contract_version TEXT NOT NULL CHECK (contract_version = '1'),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  artifact_id TEXT NOT NULL REFERENCES publication_manifest_artifacts(artifact_id),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:'),
  artifact_object_key TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('branch', 'pr')),
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40),
  head_ref TEXT NOT NULL,
  title TEXT,
  body TEXT,
  worker_id TEXT NOT NULL,
  claim_callback_id TEXT NOT NULL,
  validation_event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('authorized', 'consumed', 'abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retained_until TEXT
);

CREATE INDEX publication_intents_run_state_idx
  ON publication_intents(run_id, state);

CREATE TABLE publications (
  publication_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  contract_version TEXT NOT NULL CHECK (contract_version = '1'),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  artifact_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  artifact_object_key TEXT NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('branch', 'pr')),
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  title TEXT,
  body TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'publishing', 'published', 'retryable_failure', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempt_id TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  last_error_code TEXT,
  branch_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  retained_until TEXT
);

CREATE INDEX publications_dispatch_idx
  ON publications(state, next_attempt_at, lease_expires_at, created_at);

CREATE TABLE publication_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'publication.requested', 'publication.attempt_reserved', 'publication.started',
    'publication.branch_confirmed', 'publication.pull_request_confirmed',
    'publication.retry_scheduled', 'publication.blocked', 'publication.reconciled', 'publication.published'
  )),
  state TEXT NOT NULL CHECK (state IN ('pending', 'publishing', 'published', 'retryable_failure', 'blocked')),
  attempt_id TEXT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 12000),
  UNIQUE (publication_id, event_id)
);

CREATE INDEX publication_events_history_idx
  ON publication_events(publication_id, sequence);
