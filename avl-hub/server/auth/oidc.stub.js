'use strict';
/**
 * SSO EXTENSION POINT — Microsoft Entra ID / OIDC. NOT IMPLEMENTED (by decision).
 *
 * To add SSO later, implement an object with the same shape as server/auth/local.js:
 *   name: 'oidc'
 *   authenticate(req, credentials) -> users row   (for OIDC: called from the callback route
 *       after the code exchange; look the user up by (auth_provider='oidc', external_subject=<sub>),
 *       and only for accounts an admin has already created — no self-signup, no auto-provisioning)
 *   mountRoutes(app, ctx) -> optional; add GET /api/auth/oidc/start and /callback here
 * Then set AUTH_PROVIDER=oidc. Nothing else changes: sessions, roles, permissions and audit all key
 * off users.id, and users.auth_provider / users.external_subject already exist in the schema.
 * Users created for SSO have password_hash NULL and must_change_password 0.
 */
module.exports = function oidcProvider() {
  throw new Error('OIDC sign-in is not implemented. See server/auth/oidc.stub.js for the extension point.');
};
