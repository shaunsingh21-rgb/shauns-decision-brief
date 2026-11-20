'use strict';
const crypto = require('crypto');
const T = require('./totp');

// Everything about two-step sign-in that the routes share. If MFA_ENCRYPTION_KEY is not set the feature is simply off.
module.exports = function makeMfa({ db, config, roles, clock = Date.now }) {
  const key = config.mfaEncryptionKey;
  if (key) T.keyBuf(key);                                                    // fail fast at start-up on a malformed key
  const available = !!key;
  const row = uid => db.prepare('SELECT * FROM user_mfa WHERE user_id=?').get(uid);
  const enabled = uid => { const r = row(uid); return !!(r && r.enabled_at); };
  const requiredByRole = roleId => { const r = roles.get(roleId); return !!(r && r.require_mfa); };
  // A role can require two-step sign-in; until the person has enrolled they can do nothing else.
  const mustEnroll = u => available && requiredByRole(u.role) && !enabled(u.id);
  const secretOf = uid => { const r = row(uid); return r ? T.decrypt(r.secret_enc, key) : null; };
  const hashChallenge = raw => crypto.createHash('sha256').update(raw).digest('hex');
  const recoveryLeft = uid => db.prepare('SELECT COUNT(*) n FROM mfa_recovery_codes WHERE user_id=? AND used_at IS NULL').get(uid).n;

  // Checks a 6-digit code OR a recovery code. Returns {ok, via}. Never reveals which part was wrong.
  function checkCode(uid, input) {
    const s = String(input || '').trim();
    if (/^\s*\d[\d\s]{4,7}$/.test(s)) {
      const r = row(uid); if (!r || !r.enabled_at) return { ok: false };
      let step; try { step = T.verifyTotp(T.decrypt(r.secret_enc, key), s, { lastStep: r.last_step, nowMs: clock() }); } catch { return { ok: false }; }   // damaged secret or wrong key: fail closed
      if (step === null) return { ok: false };
      db.prepare('UPDATE user_mfa SET last_step=? WHERE user_id=? AND last_step<?').run(step, uid, step);
      return { ok: true, via: 'app' };
    }
    const h = T.hashRecovery(s), c = T.normaliseRecovery(s).length === 10 && db.prepare('SELECT id FROM mfa_recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL').get(uid, h);
    if (!c) return { ok: false };
    db.prepare('UPDATE mfa_recovery_codes SET used_at=? WHERE id=?').run(new Date().toISOString(), c.id);
    return { ok: true, via: 'recovery' };
  }
  function newRecoveryCodes(uid, n = 8) {
    const codes = Array.from({ length: n }, () => T.newRecoveryCode());
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=?').run(uid);
    for (const c of codes) db.prepare('INSERT INTO mfa_recovery_codes VALUES (?,?,?,NULL)').run(crypto.randomUUID(), uid, T.hashRecovery(c));
    return codes;
  }
  const remove = uid => { db.prepare('DELETE FROM user_mfa WHERE user_id=?').run(uid); db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=?').run(uid); db.prepare('DELETE FROM mfa_challenges WHERE user_id=?').run(uid); };
  return { available, key, clock, row, enabled, requiredByRole, mustEnroll, secretOf, hashChallenge, recoveryLeft, checkCode, newRecoveryCodes, remove, T };
};
