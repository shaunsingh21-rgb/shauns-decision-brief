-- Last-writer-wins bookkeeping: edit_at is WHEN the edit was made (client time corrected to server time, clamped), not when it arrived.
ALTER TABLE equipment ADD COLUMN edit_at TEXT;
ALTER TABLE issues ADD COLUMN edit_at TEXT;
ALTER TABLE training_modules ADD COLUMN edit_at TEXT;
ALTER TABLE photo_panels ADD COLUMN edit_at TEXT;
ALTER TABLE panel_pins ADD COLUMN edit_at TEXT;
ALTER TABLE equipment_updates ADD COLUMN edit_at TEXT;
UPDATE equipment SET edit_at = updated_at;
UPDATE issues SET edit_at = updated_at;
UPDATE training_modules SET edit_at = updated_at;
UPDATE photo_panels SET edit_at = updated_at;
UPDATE panel_pins SET edit_at = created_at;
UPDATE equipment_updates SET edit_at = created_at;

-- Replays of the same queued operation (same user + key) return the original result instead of running twice.
CREATE TABLE idempotency (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
