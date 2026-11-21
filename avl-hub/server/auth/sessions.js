'use strict';
const crypto = require('crypto');
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');

module.exports = function makeSessions(db, config) {
  const ttlMs = config.sessionTtlHours * 3600 * 1000, maxMs = (config.sessionMaxDays || 14) * 864e5;
  return {
    create(userId, ip) {
      const raw = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      db.prepare('INSERT INTO sessions (id_hash,user_id,created_at,last_seen_at,expires_at,ip) VALUES (?,?,?,?,?,?)')
        .run(hash(raw), userId, new Date(now).toISOString(), new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), ip || null);
      return raw;
    },
    // Returns the user row for a valid, unexpired session of an enabled user; slides the expiry.
    lookup(raw) {
      if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
      const h = hash(raw);
      const row = db.prepare(`SELECT s.expires_at, s.created_at AS session_created_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(h);
      if (!row) return null;
      // Idle for too long, disabled, or simply too old (a session that is used every day still ends after SESSION_MAX_DAYS).
      if (Date.parse(row.expires_at) <= Date.now() || row.disabled || Date.parse(row.session_created_at) + maxMs <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(h);
        return null;
      }
      const now = Date.now();
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?')
        .run(new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), h);
      return { user: row, sessionHash: h };
    },
    destroy(raw) { if (raw) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash(raw)); },
    destroyAllForUser(userId, exceptHash = null) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash IS NOT ?').run(userId, exceptHash);
    },
    purgeExpired() { db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()); },
  };
};
