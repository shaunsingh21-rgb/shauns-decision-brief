'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { HttpError } = require('../lib/errors');
const { z, username, parse } = require('../lib/validate');
const { cookieOptions } = require('../middleware/security');

const publicUser = u => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, must_change_password: !!u.must_change_password });

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
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: config.loginIpMax, standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts from this device. Try again later.' } }),
  });

  api.post('/auth/login', 'public', loginLimiter, async (req, res) => {
    const body = parse(z.object({ username, password: z.string().min(1).max(256) }).strict(), req.body);
    let user;
    try { user = await auth.provider.authenticate(req, body); }
    catch (e) {
      if (e instanceof HttpError && ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED'].includes(e.code)) {
        db.transaction(() => audit(req, e.code === 'ACCOUNT_LOCKED' ? 'auth.login_blocked_locked' : (e.extra.locked ? 'auth.lockout' : 'auth.login_failed'),
          'user', null, { username: body.username }, { id: null, username: body.username }))();
      }
      throw e;
    }
    if (req.sessionRaw) auth.sessions.destroy(req.sessionRaw);          // never reuse a pre-login session id
    const raw = auth.sessions.create(user.id, req.ip);
    db.transaction(() => {
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
      audit(req, 'auth.login', 'user', user.id, {}, user);
    })();
    res.cookie(config.cookieName, raw, cookieOptions(config));
    res.json({ user: publicUser(user) });
  });

  api.post('/auth/logout', 'any', async (req, res) => {
    db.transaction(() => audit(req, 'auth.logout', 'user', req.user.id))();
    auth.sessions.destroy(req.sessionRaw);
    res.clearCookie(config.cookieName, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  api.get('/me', 'any', async (req, res) => res.json({ user: publicUser(req.user) }));

  api.post('/auth/change-password', 'any', async (req, res) => {
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
