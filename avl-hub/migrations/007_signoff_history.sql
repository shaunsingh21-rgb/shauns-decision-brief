-- migrate: foreign-keys-off
-- 1. A quiz score only counts for the quiz it was taken against. NULL = taken before this was recorded (still counts).
ALTER TABLE quiz_attempts ADD COLUMN quiz_hash TEXT;
-- 2. Practical scores are ordered by WHEN THEY WERE GIVEN (the trainer's own clock, corrected and clamped), not by when they reached the server.
ALTER TABLE practical_scores ADD COLUMN event_at TEXT;
UPDATE practical_scores SET event_at = created_at;
-- 3. Sign-offs become a history. A new one is allowed once the material has changed since the last; each remembers which version of the
--    module it was for and what the scores were. Still append-only.
CREATE TABLE signoffs_new (
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL REFERENCES users(id),
  module_id TEXT NOT NULL REFERENCES training_modules(id),
  signed_by TEXT NOT NULL REFERENCES users(id),
  quiz_pct INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  module_version INTEGER,                    -- NULL for sign-offs made before versions were recorded
  scores TEXT,                               -- JSON snapshot: [{skill, score}]
  CHECK (trainee_id <> signed_by)
);
INSERT INTO signoffs_new (id,trainee_id,module_id,signed_by,quiz_pct,note,created_at)
  SELECT id,trainee_id,module_id,signed_by,quiz_pct,note,created_at FROM signoffs;
DROP TABLE signoffs;
ALTER TABLE signoffs_new RENAME TO signoffs;
CREATE INDEX signoffs_lookup ON signoffs(trainee_id, module_id);
CREATE TRIGGER signoffs_no_update BEFORE UPDATE ON signoffs BEGIN SELECT RAISE(ABORT,'signoffs are append-only'); END;
CREATE TRIGGER signoffs_no_delete BEFORE DELETE ON signoffs BEGIN SELECT RAISE(ABORT,'signoffs are append-only'); END;
