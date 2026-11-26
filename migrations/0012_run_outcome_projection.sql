ALTER TABLE runs ADD COLUMN outcome_summary_json TEXT
  CHECK (outcome_summary_json IS NULL OR json_valid(outcome_summary_json));

CREATE INDEX runs_outcome_summary_expiration_idx
  ON runs(expires_at, id)
  WHERE outcome_summary_json IS NOT NULL;
