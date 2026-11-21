-- Indexes for the lookups the app makes on every screen. Each was a full table scan (EXPLAIN QUERY PLAN "SCAN"); none changes behaviour.
CREATE INDEX quiz_questions_module ON quiz_questions(module_id);
CREATE INDEX practical_skills_module ON practical_skills(module_id);
CREATE INDEX practical_scores_latest ON practical_scores(trainee_id, skill_id, event_at DESC);
CREATE INDEX quiz_attempts_user_module ON quiz_attempts(user_id, module_id, created_at);
CREATE INDEX photo_panels_equipment ON photo_panels(equipment_id) WHERE deleted_at IS NULL;
CREATE INDEX panel_pins_panel ON panel_pins(panel_id);
CREATE INDEX files_equipment ON files(equipment_id, purpose, created_at) WHERE deleted_at IS NULL;
CREATE INDEX lesson_videos_module ON lesson_videos(module_id, position);
CREATE INDEX video_checkpoints_video ON video_checkpoints(video_id, at_seconds);
CREATE INDEX issues_updated ON issues(updated_at DESC);
CREATE INDEX issues_equipment ON issues(equipment_id);
CREATE INDEX equipment_updates_created ON equipment_updates(created_at DESC);
CREATE INDEX equipment_updates_equipment ON equipment_updates(equipment_id);
CREATE INDEX equipment_live_name ON equipment(name) WHERE deleted_at IS NULL;
CREATE INDEX equipment_fields_provenance ON equipment_fields(equipment_id, provenance);
CREATE INDEX idempotency_created ON idempotency(created_at);
CREATE INDEX sessions_expires ON sessions(expires_at);
