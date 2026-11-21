-- PROPOSED migration 008 (not in the repo). Everything is additive and nullable, so existing data and tests are unaffected.
-- 1. Re-certification: how many months a sign-off on this module stays valid. NULL = never expires.
--    IMPORTANT: this is POLICY, not content. Changing it must NOT bump training_modules.version or return the module to Needs Review,
--    or every sign-off for that module would instantly become "stale".
ALTER TABLE training_modules ADD COLUMN recert_months INTEGER CHECK (recert_months IS NULL OR recert_months BETWEEN 1 AND 60);
-- 2. Event tag on issues/lessons so a debrief can be grouped by event. Free text + date; no new entity needed for v1.
ALTER TABLE issues ADD COLUMN event_name TEXT;
ALTER TABLE issues ADD COLUMN event_date TEXT;
CREATE INDEX issues_event ON issues(event_date, kind);
-- 3. "Ready to operate X" = current (not stale, not expired) sign-off on every module in the profile.
CREATE TABLE readiness_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE readiness_profile_modules (
  profile_id TEXT NOT NULL REFERENCES readiness_profiles(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES training_modules(id),
  PRIMARY KEY (profile_id, module_id)
);
-- 4. Indexes the overview needs (the existing schema has none on these).
CREATE INDEX IF NOT EXISTS quiz_attempts_user_module ON quiz_attempts(user_id, module_id, created_at);
CREATE INDEX IF NOT EXISTS practical_scores_lookup ON practical_scores(trainee_id, skill_id, event_at);
CREATE INDEX IF NOT EXISTS equipment_fields_verify ON equipment_fields(provenance, equipment_id);
CREATE INDEX IF NOT EXISTS equipment_updates_status ON equipment_updates(status, created_at);
