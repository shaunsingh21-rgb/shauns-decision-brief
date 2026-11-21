'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { HttpError } = require('../lib/errors');
const { z, username, parse } = require('../lib/validate');
const { cookieOptions } = require('../middleware/security');

// What the app is told about the signed-in person. `permissions` drives which buttons are offered; the server re-checks every action regardless.
const publicUser = (u, perms, features, mfa = {}) => ({ features, mfa_enabled: !!mfa.enabled, must_enroll_mfa: !!mfa.mustEnroll, id: u.id, username: u.username, display_name: u.display_name, role: u.role, role_name: u.role_name, must_change_password: !!u.must_change_password, permissions: [...perms].sort() });

function checkPasswordPolicy(config, pw, uname) {
  const problems = [];
  if (pw.length < config.minPasswordLength) problems.push(`at least ${config.minPasswordLength} characters`);
  if (pw.toLowerCase().includes(String(uname).toLowerCase())) problems.push('must not contain your username');
  if (/^(.)\1+$/.test(pw)) problems.push('must not be one repeated character');
  if (problems.length) throw new HttpError(400, 'WEAK_PASSWORD', `Password needs: ${problems.join('; ')}.`);
}
const generatePassword = () => crypto.randomBytes(12).toString('base64url');

module.exports = function authRoutes(api, ctx) {
  const { db, config, audit, auth } = ctx;
  const limits = require('../middleware/limits')(config);
  const features = { mfa: !!config.mfaEncryptionKey };       // what this server can do; the app hides options it cannot offer
  const me = u => publicUser(u, ctx.roles.permissionsOf(u.role), features, { enabled: ctx.mfa.enabled(u.id), mustEnroll: ctx.mfa.mustEnroll(u) });
  const withRoleName = u => ({ ...u, role_name: (ctx.roles.get(u.role) || {}).name || u.role });
  // Shared by password-only sign-in and by the second step. A new session id every time, never reusing a pre-login one.
  function startSession(req, res, user, detail = {}) {
    if (req.sessionRaw) auth.sessions.destroy(req.sessionRaw);
    const raw = auth.sessions.create(user.id, req.ip);
    db.transaction(() => {
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
      audit(req, 'auth.login', 'user', user.id, detail, user);
    })();
    auth.provider.succeed(user.username, req.ip);                     // sign-in is complete: only now forget this address's failures
    res.cookie(config.cookieName, raw, cookieOptions(config));
    res.json({ user: me(withRoleName(user)) });
  }
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: config.loginIpMax, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,   // only failed attempts use up the allowance (a whole office signing in at 9am must not lock itself out)
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts from this device. Try again later.' } }),
  });

  api.post('/auth/login', 'public', loginLimiter, async (req, res) => {
    const body = parse(z.object({ username, password: z.string().min(1).max(256) }).strict(), req.body);
    let user;
    try { user = await auth.provider.authenticate(req, body); }
    catch (e) {
      if (e instanceof HttpError && ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED'].includes(e.code)) {
        const known = !!db.prepare('SELECT 1 FROM users WHERE username=?').get(body.username);   // a typed name that is not an account (often a password) is never written down
        db.transaction(() => audit(req, e.code === 'ACCOUNT_LOCKED' ? 'auth.login_blocked_locked' : (e.extra.locked ? 'auth.lockout' : 'auth.login_failed'),
          'user', null, known ? { username: body.username } : { username_known: false }, { id: null, username: known ? body.username : '(unknown name)' }))();
      }
      throw e;
    }
    // Two-step sign-in is on for this person: the password alone does not start a session. Fail closed if the server key is gone.
    if (ctx.mfa.enabled(user.id)) {
      if (!ctx.mfa.available) throw new HttpError(503, 'MFA_UNAVAILABLE', 'Two-step sign-in is turned on for this account, but this server is missing its key. Ask your administrator.');
      const raw = crypto.randomBytes(32).toString('base64url'), nowMs = Date.now();
      db.transaction(() => {
        db.prepare('DELETE FROM mfa_challenges WHERE user_id=? OR expires_at < ?').run(user.id, new Date(nowMs).toISOString());
        db.prepare('INSERT INTO mfa_challenges VALUES (?,?,?,?,0)').run(ctx.mfa.hashChallenge(raw), user.id, new Date(nowMs).toISOString(), new Date(nowMs + 5 * 60000).toISOString());
        audit(req, 'auth.login_mfa_challenge', 'user', user.id, {}, user);
      })();
      return res.json({ mfa_required: true, challenge: raw, expires_in_seconds: 300 });
    }
    startSession(req, res, user);
  });

  // Step two: the ticket from step one + a code from the authenticator app (or a recovery code).
  api.post('/auth/mfa/verify', 'public', loginLimiter, async (req, res) => {
    const b = parse(z.object({ challenge: z.string().min(20).max(100), code: z.string().min(4).max(40) }).strict(), req.body);
    const bad = new HttpError(401, 'INVALID_CODE', 'That code was not accepted.');
    const ch = db.prepare('SELECT * FROM mfa_challenges WHERE id_hash=?').get(ctx.mfa.hashChallenge(b.challenge));
    if (!ch || Date.parse(ch.expires_at) < Date.now()) throw new HttpError(401, 'CHALLENGE_EXPIRED', 'Sign in again: this step took too long.');
    const user = db.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(ch.user_id);
    if (!user) throw new HttpError(401, 'CHALLENGE_EXPIRED', 'Sign in again.');
    const lock = auth.provider.lockStatus(user.username, req.ip);
    if (lock.locked) throw new HttpError(429, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${lock.minutes} minute(s), or ask an administrator to unlock the account.`);
    const result = ctx.mfa.checkCode(user.id, b.code);
    if (!result.ok) {
      const { locked } = auth.provider.noteFailure(user.username, req.ip);   // shares the sign-in lockout
      const attempts = ch.attempts + 1;
      db.transaction(() => {
        if (attempts >= 5 || locked) db.prepare('DELETE FROM mfa_challenges WHERE id_hash=?').run(ch.id_hash); else db.prepare('UPDATE mfa_challenges SET attempts=? WHERE id_hash=?').run(attempts, ch.id_hash);
        audit(req, locked ? 'auth.lockout' : 'auth.mfa_failed', 'user', user.id, {}, user);
      })();
      throw attempts >= 5 || locked ? new HttpError(401, 'CHALLENGE_EXPIRED', 'Too many wrong codes. Sign in again.') : bad;
    }
    db.prepare('DELETE FROM mfa_challenges WHERE id_hash=?').run(ch.id_hash);
    if (result.via === 'recovery') db.transaction(() => audit(req, 'auth.mfa_recovery_used', 'user', user.id, { remaining: ctx.mfa.recoveryLeft(user.id) }, user))();
    startSession(req, res, user, { mfa: result.via });
  });

  api.post('/auth/logout', 'any', async (req, res) => {
    db.transaction(() => audit(req, 'auth.logout', 'user', req.user.id))();
    auth.sessions.destroy(req.sessionRaw);
    res.clearCookie(config.cookieName, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  api.get('/me', 'any', async (req, res) => res.json({ user: me(req.user) }));

  api.post('/auth/change-password', 'any', limits.password, async (req, res) => {
    const body = parse(z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(1).max(256) }).strict(), req.body);
    const u = req.user;
    if (u.auth_provider !== 'local' || !u.password_hash) throw new HttpError(400, 'NOT_LOCAL', 'This account does not use a local password.');
    if (!(await auth.provider.verifyPassword(u.password_hash, body.current_password)))
      throw new HttpError(403, 'WRONG_PASSWORD', 'Current password is incorrect.');
    checkPasswordPolicy(config, body.new_password, u.username);
    if (body.new_password === body.current_password) throw new HttpError(400, 'WEAK_PASSWORD', 'New password must differ from the current one.');
    const hash = await auth.provider.hashPassword(body.new_password);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?').run(hash, new Date().toISOString(), u.id);
      auth.sessions.destroyAllForUser(u.id, req.sessionHash);           // sign out every other device
      audit(req, 'auth.password_changed', 'user', u.id);
    })();
    res.json({ ok: true });
  });
};
module.exports.checkPasswordPolicy = checkPasswordPolicy;
module.exports.generatePassword = generatePassword;
