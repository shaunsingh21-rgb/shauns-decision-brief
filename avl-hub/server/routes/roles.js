'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, parse } = require('../lib/validate');
const { CATALOGUE, KEYS, SYSTEM_ROLES, isKey, subset } = require('../lib/permissions');

// Roles are named sets of permissions that an administrator can create and edit.
// Safety rules (so a role can never be used to climb above yourself):
//  * you can only GRANT permissions you hold yourself;
//  * you can only change or delete a role whose permissions you hold in full ("no more power than you");
//  * the built-in Leader/Admin role always holds everything and cannot be edited or removed;
//  * a role with people in it cannot be deleted.
module.exports = function roleRoutes(api, ctx) {
  const { P } = api; const { db, config, audit, roles } = ctx;
  const rate = require('../middleware/limits')(config);
  const now = () => new Date().toISOString();
  const roleId = id.or(z.string().regex(/^[a-z]{3,20}$/));          // custom roles use uuids; built-ins use short names
  const perms = z.array(z.string().refine(isKey, 'unknown permission')).max(KEYS.length);
  const role = rid => { const r = roles.get(rid); if (!r) throw new HttpError(404, 'NOT_FOUND', 'Role not found.'); return r; };
  const view = (r, req) => ({ id: r.id, name: r.name, description: r.description, is_system: !!r.is_system, locked: r.id === 'admin', require_mfa: !!r.require_mfa,
    permissions: r.permissions, user_count: r.user_count, can_edit: r.id !== 'admin' && roles.outranks(req.permissions, r.id), can_assign: roles.outranks(req.permissions, r.id) });
  const mayGrant = (req, added) => {
    const over = [...added].filter(p => !req.permissions.has(p));
    if (over.length) throw new HttpError(403, 'TOO_POWERFUL', 'You can only give permissions that you have yourself.', { not_permitted: over });
  };
  const mayChange = (req, rid) => { if (!roles.outranks(req.permissions, rid)) throw new HttpError(403, 'TOO_POWERFUL', 'This role has more power than yours, so you cannot change it.'); };
  // Whether a role must use two-step sign-in is a security policy: only someone holding every permission (Leader/Admin) may change it.
  const policyOnly = req => { if (req.permissions.size < KEYS.length) throw new HttpError(403, 'TOO_POWERFUL', 'Only a Leader/Admin can change whether a role requires two-step sign-in.'); };
  const needMfaConfigured = want => { if (want && !config.mfaEncryptionKey) throw new HttpError(400, 'MFA_NOT_CONFIGURED', 'Two-step sign-in is not set up on this server (MFA_ENCRYPTION_KEY), so it cannot be required.'); };
  const setPerms = (rid, list) => {
    db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(rid);
    for (const p of new Set(list)) db.prepare('INSERT INTO role_permissions VALUES (?,?)').run(rid, p);
  };
  const nameTaken = (name, except) => db.prepare('SELECT 1 FROM roles WHERE name=? AND id<>?').get(name, except || '');

  // Either permission may list roles: managing people needs the list for its role pickers.
  api.get('/roles', P('roles.manage', 'users.manage'), async (req, res) => res.json({ roles: roles.list().map(r => view(r, req)), catalogue: CATALOGUE }));

  api.post('/roles', P('roles.manage'), rate.sensitive, async (req, res) => {
    const b = parse(z.object({ name: text(40, 2), description: text(300).default(''), permissions: perms, require_mfa: z.boolean().default(false) }).strict(), req.body);
    if (nameTaken(b.name)) throw new HttpError(409, 'NAME_TAKEN', 'A role with that name already exists.');
    mayGrant(req, b.permissions); if (b.require_mfa) policyOnly(req); needMfaConfigured(b.require_mfa);
    const rid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO roles (id,name,description,is_system,require_mfa,created_at,updated_at) VALUES (?,?,?,0,?,?,?)').run(rid, b.name, b.description, +b.require_mfa, now(), now());
      setPerms(rid, b.permissions);
      audit(req, 'role.create', 'role', rid, { name: b.name, permissions: [...new Set(b.permissions)].sort(), require_mfa: b.require_mfa });
    })();
    res.status(201).json({ role: view(roles.list().find(r => r.id === rid), req) });
  });

  api.patch('/roles/:id', P('roles.manage'), rate.sensitive, async (req, res) => {
    const rid = parse(roleId, req.params.id); const cur = role(rid);
    const b = parse(z.object({ name: text(40, 2).optional(), description: text(300).optional(), permissions: perms.optional(), require_mfa: z.boolean().optional() }).strict(), req.body);
    if (rid === 'admin' && (b.name !== undefined || b.description !== undefined || b.permissions !== undefined))
      throw new HttpError(409, 'ROLE_LOCKED', 'The Leader/Admin role always has every permission and cannot be edited. (It can be set to require two-step sign-in.)');
    if (cur.is_system && b.name !== undefined && b.name !== cur.name) throw new HttpError(409, 'ROLE_LOCKED', 'Built-in roles keep their names. Create a new role if you want a different name.');
    mayChange(req, rid);
    if (b.name && nameTaken(b.name, rid)) throw new HttpError(409, 'NAME_TAKEN', 'A role with that name already exists.');
    const before = [...roles.permissionsOf(rid)].sort();
    if (b.permissions) mayGrant(req, b.permissions.filter(p => !before.includes(p)));          // taking permissions away is always allowed; adding needs you to hold them
    if (b.require_mfa !== undefined && b.require_mfa !== !!cur.require_mfa) { policyOnly(req); needMfaConfigured(b.require_mfa); }
    db.transaction(() => {
      db.prepare('UPDATE roles SET name=?,description=?,require_mfa=?,updated_at=? WHERE id=?').run(b.name ?? cur.name, b.description ?? cur.description, b.require_mfa === undefined ? cur.require_mfa : +b.require_mfa, now(), rid);
      if (b.permissions) setPerms(rid, b.permissions);
      audit(req, 'role.update', 'role', rid, { name: b.name ?? cur.name, before, after: b.permissions ? [...new Set(b.permissions)].sort() : before, require_mfa: b.require_mfa });
    })();
    res.json({ role: view(roles.list().find(r => r.id === rid), req) });
  });

  api.delete('/roles/:id', P('roles.manage'), rate.sensitive, async (req, res) => {
    const rid = parse(roleId, req.params.id); const cur = role(rid);
    if (cur.is_system) throw new HttpError(409, 'ROLE_LOCKED', 'Built-in roles cannot be deleted.');
    mayChange(req, rid);
    const n = db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get(rid).n;
    if (n) throw new HttpError(409, 'ROLE_IN_USE', `${n} ${n === 1 ? 'person has' : 'people have'} this role. Move them to another role first.`, { user_count: n });
    db.transaction(() => { db.prepare('DELETE FROM roles WHERE id=?').run(rid); audit(req, 'role.delete', 'role', rid, { name: cur.name, permissions: [...roles.permissionsOf(rid)] }); })();
    res.json({ ok: true });
  });

  // Put a built-in role (other than Leader/Admin) back to the permissions it shipped with.
  api.post('/roles/:id/reset', P('roles.manage'), rate.sensitive, async (req, res) => {
    const rid = parse(roleId, req.params.id); const cur = role(rid);
    const def = SYSTEM_ROLES[rid];
    if (!cur.is_system || !def || def.locked) throw new HttpError(409, 'ROLE_LOCKED', 'Only the built-in Trainer, Technician and Viewer roles can be reset.');
    mayChange(req, rid);
    const before = [...roles.permissionsOf(rid)].sort(); mayGrant(req, def.permissions.filter(p => !before.includes(p)));
    db.transaction(() => {
      db.prepare('UPDATE roles SET description=?,updated_at=? WHERE id=?').run(def.description, now(), rid); setPerms(rid, def.permissions);
      audit(req, 'role.reset', 'role', rid, { name: cur.name, before, after: [...def.permissions].sort() });
    })();
    res.json({ role: view(roles.list().find(r => r.id === rid), req) });
  });
};
