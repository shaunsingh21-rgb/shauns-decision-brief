'use strict';
const argon2 = require('argon2');
const { ipKeyGenerator } = require('express-rate-limit');
const { HttpError } = require('../lib/errors');

// Sign-in lockout, designed so that guessing is slow but a stranger cannot lock people out:
//  * every attempt is COUNTED BEFORE the slow password check, so a burst of parallel guesses cannot all slip through;
//  * the count is kept per username AND address ("ip:" keys, limit LOCKOUT_MAX_FAILURES). Someone elsewhere cannot lock you out of your own account;
//  * a higher per-username ceiling ("all:" key, LOCKOUT_GLOBAL_FAILURES) still stops a guesser who uses many addresses;
//  * the counter is only cleared when sign-in is COMPLETE (after the second step, if there is one), so authenticator codes cannot be guessed
//    by interleaving them with correct passwords.
// PROTOTYPE: at most 2 password checks at once, so the 4-thread libuv pool always has free threads for file reads (static files, photos, uploads).
const MAX_HASHING = parseInt(process.env.ARGON_CONCURRENCY || '2', 10); let hashing = 0; const waiting = [];
const slot = async () => { if (hashing >= MAX_HASHING) await new Promise(r => waiting.push(r)); hashing++; };
const release = () => { hashing--; const n = waiting.shift(); if (n) n(); };
const limited = async fn => { await slot(); try { return await fn(); } finally { release(); } };
module.exports = function localProvider({ db, config }) {
  const opts = { type: argon2.argon2id, ...(config.argon || {}) };
  let dummy;
  const dummyHash = () => (dummy ||= argon2.hash('timing-equaliser-not-a-password', opts));
  const nowIso = () => new Date().toISOString();
  const norm = u => String(u).toLowerCase();
  const addr = ip => { try { return ipKeyGenerator(ip || '', 64); } catch { return ip || ''; } };   // an IPv6 user owns a whole /64, so rotating inside it does not dodge the per-address lock
  const keys = (username, ip) => [{ key: `ip:${norm(username)}|${addr(ip)}`, max: config.lockoutMaxFailures }, { key: `all:${norm(username)}`, max: config.lockoutGlobalFailures }];
  const minsLeft = row => Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 60000));

  // A lock that has expired is removed, so the next try starts fresh.
  function live(key) {
    const row = db.prepare('SELECT * FROM login_failures WHERE key=?').get(key);
    // Failures fade: an unlocked counter that has not moved for a lock period starts again from zero (so honest typos never add up for ever).
    if (row && !row.locked_until && Date.parse(row.updated_at) <= Date.now() - config.lockoutMinutes * 60000) { db.prepare('DELETE FROM login_failures WHERE key=?').run(key); return null; }
    if (row && row.locked_until && Date.parse(row.locked_until) <= Date.now()) { db.prepare('DELETE FROM login_failures WHERE key=?').run(key); return null; }
    return row || null;
  }
  const lockedRow = (username, ip) => { for (const k of keys(username, ip)) { const r = live(k.key); if (r && r.locked_until) return r; } return null; };
  const save = (key, count, lockedUntil) => db.prepare(`INSERT INTO login_failures (key,count,locked_until,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET count=excluded.count, locked_until=excluded.locked_until, updated_at=excluded.updated_at`).run(key, count, lockedUntil, nowIso());
  const until = () => new Date(Date.now() + config.lockoutMinutes * 60000).toISOString();
  // Count an attempt BEFORE checking the password (synchronous, so atomic between requests). Over the limit => locked, refused unchecked.
  function reserve(key, max) { const row = live(key), count = (row ? row.count : 0) + 1; if (count > max) { save(key, count, until()); return { over: true }; } save(key, count, row ? row.locked_until : null); return { over: false }; }
  // After a failed check: the limit-th failure locks.
  function lockIfAtMax(key, max) { const row = live(key); if (row && row.count >= max) { if (!row.locked_until) save(key, row.count, until()); return true; } return !!(row && row.locked_until); }
  // A failure with no prior reservation (wrong authenticator code): count it and lock at the limit.
  function failNow(key, max) { const row = live(key), count = (row ? row.count : 0) + 1; const locked = count >= max; save(key, count, locked ? until() : (row ? row.locked_until : null)); return locked; }
  const lockError = row => new HttpError(429, 'ACCOUNT_LOCKED',
    `Too many failed sign-in attempts. Try again in ${minsLeft(row)} minute(s), or ask an administrator to unlock the account.`, { retry_after_minutes: minsLeft(row) });

  return {
    name: 'local',
    hashPassword: pw => argon2.hash(pw, opts),
    verifyPassword: (hash, pw) => argon2.verify(hash, pw),

    // Sign-in finished successfully: forget this address's failures, and undo only THIS attempt's share of the per-username count.
    succeed(username, ip) {
      const [perIp, all] = keys(username, ip);
      db.transaction(() => {
        db.prepare('DELETE FROM login_failures WHERE key=?').run(perIp.key);
        const row = db.prepare('SELECT locked_until FROM login_failures WHERE key=?').get(all.key);
        if (row && !row.locked_until) db.prepare('DELETE FROM login_failures WHERE key=?').run(all.key);   // a correct, complete sign-in ends the run of typos; an active lock is left alone
      })();
    },
    // Admin unlock / password reset: clears every key for that username (all addresses).
    clearAll(username) {
      const prefix = `ip:${norm(username)}|`;
      db.prepare('DELETE FROM login_failures WHERE key=? OR substr(key,1,?)=?').run(`all:${norm(username)}`, prefix.length, prefix);
    },
    // The second step (authenticator code) shares this lockout, so six-digit codes cannot be guessed.
    lockStatus(username, ip) { const r = lockedRow(username, ip); return r ? { locked: true, minutes: minsLeft(r) } : { locked: false }; },
    noteFailure(username, ip) { let locked = false; for (const k of keys(username, ip)) locked = failNow(k.key, k.max) || locked; return { locked }; },

    // Contract: resolve to a users row, or throw HttpError. Never reveals whether the username exists.
    async authenticate(req, { username, password }) {
      const ip = req && req.ip;
      const lock = lockedRow(username, ip);
      if (lock) throw lockError(lock);
      // Count this attempt NOW (before the slow hash). Over the limit: refuse without even checking the password.
      // The per-address counter goes first; an address that is already over its limit does not also push up the all-addresses counter (so one noisy address cannot lock everyone out).
      const [perIp, all] = keys(username, ip);
      if (reserve(perIp.key, perIp.max).over || reserve(all.key, all.max).over) throw lockError(lockedRow(username, ip));
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      let ok = false;
      if (user && user.auth_provider === 'local' && user.password_hash && !user.disabled) ok = await limited(() => argon2.verify(user.password_hash, password));
      else await limited(async () => argon2.verify(await dummyHash(), password));                       // keep timing similar for unknown users
      if (!ok) { const locked = keys(username, ip).map(k => lockIfAtMax(k.key, k.max)).some(Boolean); throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.', { locked }); }
      // A correct password during a burst that has since locked the account is still refused.
      const after = lockedRow(username, ip); if (after) throw lockError(after);
      return user;                                                                 // NOTE: failures are cleared by succeed(), once sign-in is fully complete
    },
  };
};
