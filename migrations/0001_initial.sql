CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY NOT NULL,
  contract_version TEXT NOT NULL CHECK (contract_version = '1'),
  repo_url TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  project_name TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'admitting', 'queued', 'claimed', 'running', 'cancel_requested', 'cancelled',
    'completed', 'failed', 'admission_failed'
  )),
  stage TEXT,
  task_mode TEXT NOT NULL CHECK (task_mode IN ('patch', 'inspect')),
  publish_mode TEXT NOT NULL CHECK (publish_mode IN ('auto', 'none', 'branch', 'pr')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_hash TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  worker_id TEXT,
  claim_expires_at TEXT,
  exit_code INTEGER,
  failure_class TEXT,
  failure_message TEXT,
  cancel_requested_at TEXT,
  idempotency_key TEXT,
  correlation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  admission_attempts INTEGER NOT NULL DEFAULT 0 CHECK (admission_attempts >= 0),
  admission_last_attempt_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key_uq
  ON runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_created_idx
  ON runs(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS runs_status_created_idx
  ON runs(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS runs_correlation_idx
  ON runs(correlation_id);

CREATE TABLE IF NOT EXISTS run_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  contract_version TEXT NOT NULL CHECK (contract_version = '1'),
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  worker_id TEXT,
  stage TEXT,
  step TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (run_id, event_id)
);

CREATE INDEX IF NOT EXISTS run_events_run_sequence_idx
  ON run_events(run_id, sequence);
