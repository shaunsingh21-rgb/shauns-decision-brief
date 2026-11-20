-- AVL Hub schema v1. Timestamps are ISO-8601 UTC strings.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','trainer','technician','viewer')),
  password_hash TEXT,                        -- NULL for externally-authenticated users (future SSO)
  must_change_password INTEGER NOT NULL DEFAULT 1,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  external_subject TEXT,                     -- Entra ID / OIDC "sub" when SSO is added
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE UNIQUE INDEX users_external ON users(auth_provider, external_subject) WHERE external_subject IS NOT NULL;

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,                  -- sha256 of the cookie value; raw id is never stored
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Keyed by lower-cased username so unknown names lock out exactly like real ones.
CREATE TABLE login_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_domains (                -- admin-listed official source domains
  domain TEXT PRIMARY KEY,
  added_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE equipment (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manufacturer TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','needs_review','approved')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE equipment_fields (
  equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL CHECK (provenance IN ('manufacturer','team','ai','verify')),
  source_url TEXT,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (equipment_id, key),
  -- never guess: VERIFY means empty; anything else must carry a value
  CHECK ((provenance = 'verify' AND value = '') OR (provenance <> 'verify' AND value <> ''))
);

CREATE TABLE equipment_approvals (           -- append-only
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  override INTEGER NOT NULL DEFAULT 0,
  override_reason TEXT,
  verify_keys TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE training_modules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  equipment_id TEXT REFERENCES equipment(id),
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','needs_review','approved')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE quiz_questions (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,                     -- JSON array of strings
  correct_index INTEGER NOT NULL
);

CREATE TABLE quiz_attempts (                 -- append-only
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  module_id TEXT NOT NULL REFERENCES training_modules(id),
  score_pct INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE practical_skills (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE practical_scores (              -- append-only; latest row per (trainee, skill) counts
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL REFERENCES users(id),
  skill_id TEXT NOT NULL REFERENCES practical_skills(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 3),
  scored_by TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE signoffs (                      -- append-only, one per trainee+module
  id TEXT PRIMARY KEY,
  trainee_id TEXT NOT NULL REFERENCES users(id),
  module_id TEXT NOT NULL REFERENCES training_modules(id),
  signed_by TEXT NOT NULL REFERENCES users(id),
  quiz_pct INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (trainee_id, module_id),
  CHECK (trainee_id <> signed_by)
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('issue','lesson')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  equipment_id TEXT REFERENCES equipment(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Update management. Records what is available; the app NEVER installs anything.
CREATE TABLE equipment_updates (
  id TEXT PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  kind TEXT NOT NULL CHECK (kind IN ('firmware','software','other')),
  available_version TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','scheduled','installed_by_human','skipped')),
  status_by TEXT REFERENCES users(id),
  status_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  ip TEXT
);

-- Append-only enforcement at the database level.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER signoffs_no_update BEFORE UPDATE ON signoffs BEGIN SELECT RAISE(ABORT,'signoffs are append-only'); END;
CREATE TRIGGER signoffs_no_delete BEFORE DELETE ON signoffs BEGIN SELECT RAISE(ABORT,'signoffs are append-only'); END;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON equipment_approvals BEGIN SELECT RAISE(ABORT,'approvals are append-only'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON equipment_approvals BEGIN SELECT RAISE(ABORT,'approvals are append-only'); END;
