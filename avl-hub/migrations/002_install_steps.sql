CREATE TABLE install_steps (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('manufacturer','team','ai')),
  source_url TEXT
);
CREATE INDEX install_steps_eq ON install_steps(equipment_id, position);
CREATE TABLE install_progress (              -- per-user checklist state for the installation assistant
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES install_steps(id) ON DELETE CASCADE,
  done_at TEXT NOT NULL,
  PRIMARY KEY (user_id, step_id)
);
