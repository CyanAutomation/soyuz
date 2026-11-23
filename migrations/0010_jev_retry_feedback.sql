CREATE TABLE jev_feedback_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL CHECK (profile_id IN (
    'run_operations_triage_v1',
    'kaseki_output_review_v1',
    'kaseki_output_review_v2',
    'run_retry_review_v1'
  )),
  github_user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('helpful', 'not_helpful')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, profile_id, github_user_id)
);

INSERT INTO jev_feedback_next (id, run_id, profile_id, github_user_id, rating, created_at, updated_at)
SELECT id, run_id, profile_id, github_user_id, rating, created_at, updated_at
FROM jev_feedback;

DROP TABLE jev_feedback;
ALTER TABLE jev_feedback_next RENAME TO jev_feedback;

CREATE INDEX jev_feedback_profile_rating_idx
  ON jev_feedback(profile_id, rating, updated_at DESC);
