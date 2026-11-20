-- migrate: foreign-keys-off
-- Roles become data. The four built-in roles keep their ids (admin, trainer, technician, viewer), so every existing account keeps working.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0,
  require_mfa INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);
INSERT INTO roles (id,name,description,is_system,created_at,updated_at) VALUES
  ('admin','Leader/Admin','Everything. Cannot be edited or removed.',1,datetime('now'),datetime('now')),
  ('trainer','Trainer','Runs training: writes material, scores practicals, signs people off.',1,datetime('now'),datetime('now')),
  ('technician','Technician','Day-to-day use: equipment, issues, updates, and taking training.',1,datetime('now'),datetime('now')),
  ('viewer','Viewer','Read-only.',1,datetime('now'),datetime('now'));
-- admin's permissions are computed in code (always all of them); the others are seeded with their defaults.
INSERT INTO role_permissions (role_id,permission) VALUES
  ('trainer','equipment.edit'),('trainer','files.delete'),('trainer','research.use'),('trainer','updates.record'),('trainer','issues.write'),('trainer','issues.manage'),
  ('trainer','training.take'),('trainer','training.author'),('trainer','training.score'),('trainer','training.signoff'),('trainer','progress.view_all'),
  ('technician','equipment.edit'),('technician','research.use'),('technician','updates.record'),('technician','issues.write'),('technician','training.take');

-- Rebuild users without the fixed list of four role names; role now points at roles(id).
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(id),
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  external_subject TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
INSERT INTO users_new (id,username,display_name,role,password_hash,must_change_password,auth_provider,external_subject,disabled,created_at,updated_at,last_login_at)
  SELECT id,username,display_name,role,password_hash,must_change_password,auth_provider,external_subject,disabled,created_at,updated_at,last_login_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX users_external ON users(auth_provider, external_subject) WHERE external_subject IS NOT NULL;
