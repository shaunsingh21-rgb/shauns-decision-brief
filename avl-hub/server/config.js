'use strict';
// All configuration comes from environment variables. No secrets live in code.
const fs = require('fs');
const path = require('path');
// The helper scripts (doctor, restore, reset-password…) run outside the service manager, so they read the same .env file the server uses.
// Values already present in the real environment always win. Set AVL_NO_ENV_FILE=1 to skip this (tests do).
function loadEnvFile() {
  if (process.env.AVL_NO_ENV_FILE) return;
  let txt; try { txt = fs.readFileSync(process.env.ENV_FILE || path.join(__dirname, '..', '.env'), 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');   // an unquoted "value   # comment" is the value only
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile();
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
module.exports = function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: int(env.PORT, 3000),
    dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'avl-hub.db'),
    uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    production: env.NODE_ENV === 'production',
    nodeEnvRaw: env.NODE_ENV || null,
    logDir: env.LOG_DIR || null,
    trustProxy: env.TRUST_PROXY ? (/^true$/i.test(env.TRUST_PROXY) ? 1 : (int(env.TRUST_PROXY, 1) || 0)) : 0,   // set 1 behind Caddy/nginx
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    lockoutMaxFailures: int(env.LOCKOUT_MAX_FAILURES, 5),
    lockoutMinutes: int(env.LOCKOUT_MINUTES, 15),
    lockoutGlobalFailures: int(env.LOCKOUT_GLOBAL_FAILURES, 20),   // per username across ALL addresses (the per-address limit is lockoutMaxFailures)
    quizAttemptsPerHour: int(env.QUIZ_ATTEMPTS_PER_HOUR, 6),         // per person per module
    sessionMaxDays: int(env.SESSION_MAX_DAYS, 14),                 // a session never lives longer than this, however busy
    loginIpMax: int(env.LOGIN_IP_MAX, 30),                       // per 15 min per IP
    apiRateMax: int(env.API_RATE_MAX, 600),
    apiReadRateMax: int(env.API_READ_RATE_MAX, 6000),                      // per minute per IP
    minPasswordLength: int(env.MIN_PASSWORD_LENGTH, 12),
    authProvider: env.AUTH_PROVIDER || 'local',
    // Used only by server-side features in later phases; never sent to the client.
    braveApiKey: env.BRAVE_API_KEY || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    maxPhotoMb: int(env.MAX_PHOTO_MB, 10),
    maxDocMb: int(env.MAX_DOC_MB, 20),
    maxVideoMb: int(env.MAX_VIDEO_MB, 200),
    // Comma-separated SharePoint hosts allowed in embeds (e.g. moody.sharepoint.com). Empty = any *.sharepoint.com.
    sharepointHosts: (env.SHAREPOINT_HOSTS || '').split(',').map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean),   // tolerate https://host/ pasted from a browser
    // 32-byte key (64 hex characters) that encrypts two-step sign-in secrets at rest. Unset = two-step sign-in is off. Make one with: openssl rand -hex 32
    mfaEncryptionKey: env.MFA_ENCRYPTION_KEY || null,
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    aiRatePerHour: int(env.AI_RATE_PER_HOUR, 30),
    // Per-user limits on sensitive actions (the global per-IP limit and login lockout are separate).
    rateUploadsPerHour: int(env.RATE_UPLOADS_PER_HOUR, 120),
    rateSensitivePerHour: int(env.RATE_SENSITIVE_PER_HOUR, 60),
    ratePasswordPer15Min: int(env.RATE_PASSWORD_PER_15MIN, 10),
    backupDir: env.BACKUP_DIR || path.join(__dirname, '..', 'backups'),
    ...overrides,
  };
  // __Host- cookies must be Secure, path=/ and have no Domain, which is exactly what we set in production.
  cfg.cookieName = overrides.cookieName || (cfg.production ? '__Host-avl_sid' : 'avl_sid');
  return cfg;
};
