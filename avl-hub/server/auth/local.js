'use strict';
const argon2 = require('argon2');
const { HttpError } = require('../lib/errors');

module.exports = function localProvider({ db, config }) {
  const opts = { type: argon2.argon2id, ...(config.argon || {}) };
  let dummy;
  const dummyHash = () => (dummy ||= argon2.hash('timing-equaliser-not-a-password', opts));
  const now = () => new Date();

  function lockState(key) {
    const row = db.prepare('SELECT * FROM login_failures WHERE key = ?').get(key);
    if (!row) return null;
    if (row.locked_until && Date.parse(row.locked_until) > Date.now()) return row;
    if (row.locked_until) db.prepare('DELETE FROM login_failures WHERE key = ?').run(key); // lock expired: fresh start
    return row.locked_until ? null : row;
  }
  function recordFailure(key) {
    const row = db.prepare('SELECT count FROM login_failures WHERE key = ?').get(key);
    const count = (row ? row.count : 0) + 1;
    const lockedUntil = count >= config.lockoutMaxFailures ? new Date(Date.now() + config.lockoutMinutes * 60000).toISOString() : null;
    db.prepare(`INSERT INTO login_failures (key,count,locked_until,updated_at) VALUES (?,?,?,?)
                ON CONFLICT(key) DO UPDATE SET count=excluded.count, locked_until=excluded.locked_until, updated_at=excluded.updated_at`)
      .run(key, count, lockedUntil, now().toISOString());
    return { locked: !!lockedUntil };
  }

  return {
    name: 'local',
    hashPassword: pw => argon2.hash(pw, opts),
    verifyPassword: (hash, pw) => argon2.verify(hash, pw),
    clearFailures: key => db.prepare('DELETE FROM login_failures WHERE key = ?').run(key.toLowerCase()),
    // The second step (authenticator code) shares the sign-in lockout, so six-digit codes cannot be guessed.
    lockStatus(username) { const st = lockState(String(username).toLowerCase()); if (st && st.locked_until) return { locked: true, minutes: Math.max(1, Math.ceil((Date.parse(st.locked_until) - Date.now()) / 60000)) }; return { locked: false }; },
    noteFailure: username => recordFailure(String(username).toLowerCase()),

    // Contract: resolve to a users row, or throw HttpError. Never reveals whether the username exists.
    async authenticate(_req, { username, password }) {
      const key = String(username).toLowerCase();
      const st = lockState(key);
      if (st && st.locked_until) {
        const mins = Math.max(1, Math.ceil((Date.parse(st.locked_until) - Date.now()) / 60000));
        throw new HttpError(429, 'ACCOUNT_LOCKED',
          `Too many failed sign-in attempts. Try again in ${mins} minute(s), or ask an administrator to unlock the account.`,
          { retry_after_minutes: mins });
      }
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      let ok = false;
      if (user && user.auth_provider === 'local' && user.password_hash && !user.disabled) {
        ok = await argon2.verify(user.password_hash, password);
      } else {
        await argon2.verify(await dummyHash(), password); // keep timing similar for unknown users
      }
      if (!ok) {
        const { locked } = recordFailure(key);
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.', { locked });
      }
      db.prepare('DELETE FROM login_failures WHERE key = ?').run(key);
      return user;
    },
  };
};
