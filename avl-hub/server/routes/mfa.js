'use strict';
const QRCode = require('qrcode');
const { HttpError } = require('../lib/errors');
const { z, parse } = require('../lib/validate');

// Self-service two-step sign-in. Every change needs the current password (and, to turn it off, a current code), so a borrowed,
// unlocked session cannot quietly switch it off or enrol an attacker's phone.
module.exports = function mfaRoutes(api, ctx) {
  const { db, config, audit, auth, mfa } = ctx;
  const limits = require('../middleware/limits')(config);
  const T = mfa.T;
  const need = () => { if (!mfa.available) throw new HttpError(400, 'MFA_NOT_CONFIGURED', 'Two-step sign-in is not set up on this server.'); };
  const checkPassword = async (u, pw) => {
    if (u.auth_provider !== 'local' || !u.password_hash) throw new HttpError(400, 'NOT_LOCAL', 'This account does not use a local password.');
    if (!(await auth.provider.verifyPassword(u.password_hash, pw))) throw new HttpError(403, 'WRONG_PASSWORD', 'That password is not correct.');
  };
  const status = u => ({ available: mfa.available, enabled: mfa.enabled(u.id), required_by_role: mfa.requiredByRole(u.role), recovery_codes_left: mfa.enabled(u.id) ? mfa.recoveryLeft(u.id) : 0 });

  api.get('/auth/mfa', 'any', async (req, res) => res.json(status(req.user)));

  // Step 1 of turning it on: make a secret (kept pending, encrypted) and show it as a QR code and as typed-in text.
  api.post('/auth/mfa/setup', 'any', limits.password, async (req, res) => {
    need(); const b = parse(z.object({ password: z.string().min(1).max(256) }).strict(), req.body); await checkPassword(req.user, b.password);
    if (mfa.enabled(req.user.id)) throw new HttpError(409, 'ALREADY_ENABLED', 'Two-step sign-in is already on. Turn it off first to set up a new phone.');
    const secret = T.newSecret(), b32 = T.base32Encode(secret);
    db.transaction(() => {
      db.prepare('DELETE FROM user_mfa WHERE user_id=?').run(req.user.id);
      db.prepare('INSERT INTO user_mfa (user_id,secret_enc,created_at) VALUES (?,?,?)').run(req.user.id, T.encrypt(secret, mfa.key), new Date().toISOString());
    })();
    const uri = T.otpauthUri({ issuer: 'AVL Tech Hub', account: req.user.username, secretB32: b32 });
    res.json({ secret: b32.match(/.{1,4}/g).join(' '), otpauth_uri: uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) });
  });

  // Step 2: prove the app works by typing a code it shows. Only then is it turned on; recovery codes are shown once.
  api.post('/auth/mfa/enable', 'any', limits.password, async (req, res) => {
    need(); const b = parse(z.object({ code: z.string().min(4).max(12) }).strict(), req.body);
    const r = mfa.row(req.user.id); if (!r) throw new HttpError(409, 'NOT_STARTED', 'Start setup first.'); if (r.enabled_at) throw new HttpError(409, 'ALREADY_ENABLED', 'Already on.');
    let step = null; try { step = T.verifyTotp(T.decrypt(r.secret_enc, mfa.key), b.code, { lastStep: r.last_step, nowMs: mfa.clock() }); } catch { /* unreadable secret: treat as wrong */ }
    if (step === null) throw new HttpError(400, 'INVALID_CODE', 'That code was not accepted. Check the time on your phone and try the newest code.');
    let codes;
    db.transaction(() => {
      db.prepare('UPDATE user_mfa SET enabled_at=?, last_step=? WHERE user_id=?').run(new Date().toISOString(), step, req.user.id);
      codes = mfa.newRecoveryCodes(req.user.id);
      auth.sessions.destroyAllForUser(req.user.id, req.sessionHash);                 // other devices must sign in again, now with the second step
      audit(req, 'mfa.enabled', 'user', req.user.id);
    })();
    res.json({ enabled: true, recovery_codes: codes });
  });

  api.post('/auth/mfa/disable', 'any', limits.password, async (req, res) => {
    need(); const b = parse(z.object({ password: z.string().min(1).max(256), code: z.string().min(4).max(40) }).strict(), req.body); await checkPassword(req.user, b.password);
    if (!mfa.enabled(req.user.id)) throw new HttpError(409, 'NOT_ENABLED', 'Two-step sign-in is not on.');
    if (mfa.requiredByRole(req.user.role)) throw new HttpError(403, 'MFA_REQUIRED_BY_ROLE', 'Your role requires two-step sign-in, so it cannot be turned off.');
    if (!mfa.checkCode(req.user.id, b.code).ok) throw new HttpError(400, 'INVALID_CODE', 'That code was not accepted.');
    db.transaction(() => { mfa.remove(req.user.id); auth.sessions.destroyAllForUser(req.user.id, req.sessionHash); audit(req, 'mfa.disabled', 'user', req.user.id); })();
    res.json({ enabled: false });
  });

  api.post('/auth/mfa/recovery-codes', 'any', limits.password, async (req, res) => {
    need(); const b = parse(z.object({ password: z.string().min(1).max(256), code: z.string().min(4).max(40) }).strict(), req.body); await checkPassword(req.user, b.password);
    if (!mfa.enabled(req.user.id)) throw new HttpError(409, 'NOT_ENABLED', 'Two-step sign-in is not on.');
    if (!mfa.checkCode(req.user.id, b.code).ok) throw new HttpError(400, 'INVALID_CODE', 'That code was not accepted.');
    let codes; db.transaction(() => { codes = mfa.newRecoveryCodes(req.user.id); audit(req, 'mfa.recovery_codes_replaced', 'user', req.user.id); })();
    res.json({ recovery_codes: codes });
  });
};
