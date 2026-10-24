-- This placeholder satisfies NOT NULL while existing rows are backfilled and
-- new rows are assigned their sequence value by the insert trigger below.
ALTER TABLE runs ADD COLUMN display_id TEXT NOT NULL DEFAULT 'soyuz-0';

CREATE TABLE run_display_numbers (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE
);

INSERT INTO run_display_numbers (run_id)
SELECT id FROM runs ORDER BY created_at ASC, id ASC;

UPDATE runs
SET display_id = 'soyuz-' || (
  SELECT number FROM run_display_numbers WHERE run_id = runs.id
);

CREATE UNIQUE INDEX runs_display_id_uq ON runs(display_id);

CREATE TRIGGER runs_assign_display_id
AFTER INSERT ON runs
BEGIN
  INSERT INTO run_display_numbers (run_id) VALUES (NEW.id);
  UPDATE runs
  SET display_id = 'soyuz-' || (
    SELECT number FROM run_display_numbers WHERE run_id = NEW.id
  )
  WHERE id = NEW.id;
END;
