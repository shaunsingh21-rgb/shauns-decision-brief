'use strict';
const { HttpError } = require('../lib/errors');

// Cookie session -> req.user
exports.session = ctx => (req, _res, next) => {
  const raw = parseCookie(req.headers.cookie, ctx.config.cookieName);
  const found = raw && ctx.auth.sessions.lookup(raw);
  if (found) {
    req.user = found.user; req.sessionHash = found.sessionHash; req.sessionRaw = raw;
    req.permissions = ctx.roles.permissionsOf(found.user.role);              // looked up per request: role edits apply immediately
    req.user.role_name = (ctx.roles.get(found.user.role) || {}).name || found.user.role;
    req.user.must_enroll_mfa = ctx.mfa.mustEnroll(found.user);
  }
  next();
};
function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
exports.cookieOptions = config => ({ httpOnly: true, sameSite: 'lax', secure: config.production, path: '/', maxAge: config.sessionTtlHours * 3600 * 1000 });

// CSRF: SameSite=Lax cookie plus a custom header that cross-site forms/fetches cannot send without a CORS preflight.
exports.csrf = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-by') !== 'avl-hub') return next(new HttpError(403, 'CSRF', 'Missing request header.'));
  next();
};

const PASSWORD_CHANGE_ALLOWED = new Set(['/me', '/auth/change-password', '/auth/logout']);
const MFA_ENROL_ALLOWED = new Set(['/me', '/auth/logout', '/auth/mfa', '/auth/mfa/setup', '/auth/mfa/enable']);
exports.requireAuth = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.'));
  if (req.user.must_change_password && !PASSWORD_CHANGE_ALLOWED.has(req.path))
    return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.'));
  if (req.user.must_enroll_mfa && !MFA_ENROL_ALLOWED.has(req.path))
    return next(new HttpError(403, 'MFA_ENROLLMENT_REQUIRED', 'Your role requires two-step sign-in. Set it up before continuing.'));
  next();
};
// Allowed if the person's role holds ANY of the listed permissions.
exports.requirePermission = perms => (req, _res, next) =>
  perms.some(p => req.permissions.has(p)) ? next() : next(new HttpError(403, 'FORBIDDEN', 'Your role does not allow this action.'));
