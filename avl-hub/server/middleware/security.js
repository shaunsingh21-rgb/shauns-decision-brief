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
    req.user.mfa_blocked = !ctx.mfa.available && ctx.mfa.requiredByRole(found.user.role);       // required but the server has no key: fail closed
  }
  next();
};
function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }   // a mangled cookie means "no session", never an error
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
// The two "you must do this first" gates each let the OTHER's routes through. Otherwise a new person in a role that requires two-step sign-in
// could never finish: changing the password would wait for two-step, and two-step setup would wait for the password.
const MFA_ENROL_ALLOWED = new Set(['/me', '/auth/logout', '/auth/mfa', '/auth/mfa/setup', '/auth/mfa/enable', '/auth/change-password']);
const PASSWORD_AND_MFA_ALLOWED = new Set([...PASSWORD_CHANGE_ALLOWED, '/auth/mfa', '/auth/mfa/setup', '/auth/mfa/enable']);
exports.requireAuth = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.'));
  // The app tells us who IT thinks is signed in. If another tab on this browser signed in as someone else, refuse rather than act as the wrong person.
  const acting = req.get('x-acting-user');
  if (acting && acting !== req.user.id) return next(new HttpError(409, 'SESSION_CHANGED', 'Someone else signed in on this browser. Reload the page.'));
  if (req.user.mfa_blocked && !['/me', '/auth/logout'].includes(req.path))
    return next(new HttpError(503, 'MFA_UNAVAILABLE', 'Your role requires two-step sign-in, but this server is missing its key. Ask your administrator.'));
  if (req.user.must_change_password && !(req.user.must_enroll_mfa ? PASSWORD_AND_MFA_ALLOWED : PASSWORD_CHANGE_ALLOWED).has(req.path))
    return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing.'));
  if (req.user.must_enroll_mfa && !MFA_ENROL_ALLOWED.has(req.path))
    return next(new HttpError(403, 'MFA_ENROLLMENT_REQUIRED', 'Your role requires two-step sign-in. Set it up before continuing.'));
  next();
};
// Allowed if the person's role holds ANY of the listed permissions.
exports.requirePermission = perms => (req, _res, next) =>
  perms.some(p => req.permissions.has(p)) ? next() : next(new HttpError(403, 'FORBIDDEN', 'Your role does not allow this action.'));
