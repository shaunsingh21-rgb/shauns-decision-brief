CREATE TABLE files (                          -- metadata only; bytes live on disk under UPLOAD_DIR, never in the database
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('photo','document','video')),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  equipment_id TEXT REFERENCES equipment(id),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE lesson_videos (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sharepoint_embed','upload','link')),
  url TEXT,
  file_id TEXT REFERENCES files(id),
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'upload' AND file_id IS NOT NULL AND url IS NULL) OR (kind <> 'upload' AND url IS NOT NULL AND file_id IS NULL))
);
CREATE TABLE video_checkpoints (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES lesson_videos(id) ON DELETE CASCADE,
  at_seconds INTEGER NOT NULL CHECK (at_seconds >= 0),
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_index INTEGER NOT NULL
);
CREATE TABLE checkpoint_responses (            -- append-only, attributed to the signed-in user; formative, not part of sign-off
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  checkpoint_id TEXT NOT NULL REFERENCES video_checkpoints(id) ON DELETE CASCADE,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE photo_panels (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  title TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','needs_review','approved')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE panel_pins (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL REFERENCES photo_panels(id) ON DELETE CASCADE,
  x REAL NOT NULL CHECK (x BETWEEN 0 AND 1),
  y REAL NOT NULL CHECK (y BETWEEN 0 AND 1),
  label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL CHECK (provenance IN ('manufacturer','team','ai','verify')),
  source_url TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  CHECK ((provenance = 'verify' AND label = '') OR (provenance <> 'verify' AND label <> ''))
);
CREATE TABLE panel_approvals (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL REFERENCES photo_panels(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  override INTEGER NOT NULL DEFAULT 0,
  override_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER panel_approvals_no_update BEFORE UPDATE ON panel_approvals BEGIN SELECT RAISE(ABORT,'approvals are append-only'); END;
CREATE TRIGGER panel_approvals_no_delete BEFORE DELETE ON panel_approvals BEGIN SELECT RAISE(ABORT,'approvals are append-only'); END;
CREATE TRIGGER checkpoint_resp_no_update BEFORE UPDATE ON checkpoint_responses BEGIN SELECT RAISE(ABORT,'responses are append-only'); END;
