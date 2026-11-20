-- Optional two-step sign-in (authenticator app). Off unless a person enrols or an admin requires it for a role.
CREATE TABLE user_mfa (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,                  -- AES-256-GCM; the key lives only in MFA_ENCRYPTION_KEY, never in the database or a backup
  enabled_at TEXT,                           -- NULL while enrolment is unfinished
  last_step INTEGER NOT NULL DEFAULT 0,      -- last accepted 30-second window: a code cannot be used twice
  created_at TEXT NOT NULL
);
CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,                   -- hash only; each code works once
  used_at TEXT
);
CREATE INDEX mfa_recovery_user ON mfa_recovery_codes(user_id);
-- Between the password and the code: a short-lived, single-use, attempt-limited ticket (no session exists yet).
CREATE TABLE mfa_challenges (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
