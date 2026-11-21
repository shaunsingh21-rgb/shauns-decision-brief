'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const Database = require('better-sqlite3');
const { harness } = require('../helpers');
const { migrate } = require('../../server/db');

let h, ac, admin;
before(async () => { h = await harness(); admin = await h.makeUser('admin'); ac = await h.as(admin); });
after(() => h.close());
const mkRole = async (name, permissions, extra = {}) => (await ac.post('/api/roles', { name, permissions, ...extra })).body;
const userWith = async (roleId, name) => { const u = await h.makeUser(roleId, name); return { u, c: await h.as(u) }; };

test('the admin sees the four built-in roles and the permission catalogue; Leader/Admin is locked', async () => {
  const r = await ac.get('/api/roles');
  assert.equal(r.status, 200); assert.deepEqual(r.body.roles.filter(x => x.is_system).map(x => x.id).sort(), ['admin', 'technician', 'trainer', 'viewer']);
  const a = r.body.roles.find(x => x.id === 'admin'); assert.equal(a.locked, true); assert.equal(a.can_edit, false); assert.equal(a.permissions.length, r.body.catalogue.length);
  assert.ok(r.body.catalogue.every(p => p.key && p.label && p.group));
});

test('create a custom role, give it to someone: they get exactly those powers, shown by /me, and nothing else', async () => {
  const created = await mkRole('Camera Operator', ['equipment.edit', 'training.take']);
  assert.equal(created.role.name, 'Camera Operator'); assert.equal(created.role.is_system, false);
  const made = await ac.post('/api/users', { username: 'cam.op', display_name: 'Cam Op', role: created.role.id });
  assert.equal(made.status, 201); assert.equal(made.body.user.role_name, 'Camera Operator');
  const c = h.client(); await c.login('cam.op', made.body.temporary_password); await c.post('/api/auth/change-password', { current_password: made.body.temporary_password, new_password: 'A-brand-new-passphrase' });
  const me = (await c.get('/api/me')).body.user; assert.deepEqual(me.permissions, ['equipment.edit', 'training.take']); assert.equal(me.role_name, 'Camera Operator');
  const e = (await c.post('/api/equipment', { name: 'SAMPLE by custom role', fields: [] })); assert.equal(e.status, 201);
  assert.equal((await c.post(`/api/equipment/${e.body.equipment.id}/approve`, {})).status, 403, 'no approve permission');
  assert.equal((await c.post('/api/issues', { kind: 'issue', title: 'x' })).status, 403, 'no issues.write');
  assert.equal((await c.get('/api/users')).status, 403); assert.equal((await c.get('/api/roles')).status, 403);
});

test('changing a role takes effect on the very next request (no re-login), in both directions', async () => {
  const role = (await mkRole('Shifting', ['equipment.edit'])).role; const { c } = await userWith(role.id, 'shifter');
  assert.equal((await c.post('/api/equipment', { name: 'SAMPLE 1', fields: [] })).status, 201);
  await ac.patch(`/api/roles/${role.id}`, { permissions: ['issues.write'] });
  assert.equal((await c.post('/api/equipment', { name: 'SAMPLE 2', fields: [] })).status, 403, 'permission removed immediately');
  assert.equal((await c.post('/api/issues', { kind: 'issue', title: 'x' })).status, 201, 'permission added immediately');
  assert.deepEqual((await c.get('/api/me')).body.user.permissions, ['issues.write']);
});

test('separate approve permissions: a custom "Reviewer" role can approve equipment and training but nothing more', async () => {
  const role = (await mkRole('Reviewer', ['equipment.approve', 'training.approve'])).role; const { c } = await userWith(role.id, 'reviewer1');
  const tc = await h.as(await h.makeUser('trainer')); const e = (await tc.post('/api/equipment', { name: 'SAMPLE', fields: [] })).body.equipment; const m = (await tc.post('/api/modules', { title: 'SAMPLE', level: 1 })).body.module;
  assert.equal((await c.post(`/api/equipment/${e.id}/approve`, { reviewed_version: e.version })).status, 200);
  assert.equal((await c.post(`/api/modules/${m.id}/approve`, { reviewed_version: m.version })).status, 200);
  assert.equal((await c.post('/api/equipment', { name: 'SAMPLE', fields: [] })).status, 403, 'approving is not editing');
  assert.equal((await c.del(`/api/equipment/${e.id}`)).status, 403, 'approving is not deleting');
});

test('ANTI-ESCALATION (roles): you can only grant permissions you hold, and only change roles with no more power than yours', async () => {
  const mgr = (await mkRole('Role Manager', ['roles.manage', 'equipment.edit'])).role; const { c } = await userWith(mgr.id, 'rolemgr');
  const grantUsers = await c.post('/api/roles', { name: 'Sneaky', permissions: ['users.manage'] });
  assert.equal(grantUsers.status, 403); assert.equal(grantUsers.body.error.code, 'TOO_POWERFUL'); assert.deepEqual(grantUsers.body.error.not_permitted, ['users.manage']);
  assert.equal((await c.post('/api/roles', { name: 'Fine', permissions: ['equipment.edit'] })).status, 201, 'can grant what it holds');
  assert.equal((await c.patch(`/api/roles/${mgr.id}`, { permissions: ['roles.manage', 'equipment.edit', 'audit.view'] })).status, 403, 'cannot add audit.view to its own role');
  assert.equal((await c.patch('/api/roles/trainer', { permissions: [] })).status, 403, 'cannot strip the Trainer role: it has more power than the manager');
  assert.equal((await c.del('/api/roles/trainer')).status, 409, 'built-in roles cannot be deleted');
  assert.equal((await c.post('/api/roles/trainer/reset')).status, 403);
  assert.equal((await c.patch('/api/roles/admin', { permissions: [] })).status, 409); assert.equal((await c.patch('/api/roles/admin', { name: 'Hacked' })).status, 409);
  assert.deepEqual((await ac.get('/api/roles')).body.roles.find(r => r.id === 'admin').permissions.length, KEYS_COUNT());
  const strongRole = (await mkRole('Strong', ['equipment.edit', 'audit.view'])).role;
  assert.equal((await c.patch(`/api/roles/${strongRole.id}`, { description: 'x' })).status, 403, 'a role holding audit.view is more powerful than the manager');
  assert.equal((await c.del(`/api/roles/${strongRole.id}`)).status, 403);
});
const KEYS_COUNT = () => require('../../server/lib/permissions').KEYS.length;

test('ANTI-ESCALATION (people): managing people never lets you take over or create anyone more powerful than you', async () => {
  const pm = (await mkRole('People Manager', ['users.manage'])).role; const { u, c } = await userWith(pm.id, 'peoplemgr');
  const quiet = (await mkRole('Quiet', [])).role; const adminId = admin.id;
  assert.equal((await c.post(`/api/users/${adminId}/reset-password`)).status, 403, 'cannot reset an administrator\'s password (that would be a takeover)');
  assert.equal((await c.patch(`/api/users/${adminId}`, { disabled: true })).status, 403); assert.equal((await c.post(`/api/users/${adminId}/unlock`)).status, 403);
  assert.equal((await c.patch(`/api/users/${adminId}`, { role: 'viewer' })).status, 403, 'cannot demote an admin either');
  const trainerUser = await h.makeUser('trainer'); assert.equal((await c.post(`/api/users/${trainerUser.id}/reset-password`)).status, 403, 'trainer has more power than this manager');
  assert.equal((await c.post('/api/users', { username: 'wannabe', display_name: 'W', role: 'admin' })).status, 403, 'cannot create an administrator');
  assert.equal((await c.post('/api/users', { username: 'wannabe', display_name: 'W', role: 'trainer' })).status, 403, 'cannot hand out powers it does not have');
  assert.equal((await c.patch(`/api/users/${u.id}`, { role: 'admin' })).status, 403, 'cannot promote itself');
  assert.equal((await c.patch(`/api/users/${u.id}`, { role: 'trainer' })).status, 403);
  assert.equal((await c.post('/api/users', { username: 'ok.user', display_name: 'OK', role: quiet.id })).status, 201, 'can create people in roles with no more power than its own');
  assert.equal((await c.post('/api/users', { username: 'ok.viewer', display_name: 'OK', role: 'viewer' })).status, 201);
  const viewer = await h.makeUser('viewer'); assert.equal((await c.post(`/api/users/${viewer.id}/reset-password`)).status, 200);
  assert.equal((await c.post('/api/users', { username: 'bad.role', display_name: 'X', role: crypto.randomUUID() })).body.error.code, 'BAD_ROLE');
  assert.equal(h.db.prepare("SELECT role FROM users WHERE id=?").get(adminId).role, 'admin', 'the administrator is untouched');
});

test('roles are validated: unknown permissions, extra fields, duplicate names (any case), short names, and the empty set are handled', async () => {
  assert.equal((await ac.post('/api/roles', { name: 'Bad', permissions: ['equipment.fly'] })).status, 400);
  assert.equal((await ac.post('/api/roles', { name: 'Bad', permissions: [], is_system: true })).status, 400, 'no mass assignment');
  assert.equal((await ac.post('/api/roles', { name: 'x', permissions: [] })).status, 400);
  await mkRole('Unique Name', []); assert.equal((await ac.post('/api/roles', { name: 'unique name', permissions: [] })).body.error.code, 'NAME_TAKEN');
  assert.equal((await ac.post('/api/roles', { name: 'Trainer', permissions: [] })).status, 409, 'cannot reuse a built-in name');
  assert.equal((await ac.post('/api/roles', { name: 'Empty Role', permissions: [] })).status, 201, 'a role with no permissions is a valid read-only role');
  assert.equal((await ac.patch('/api/roles/trainer', { name: 'Coach' })).status, 409, 'built-in roles keep their names');
  assert.equal((await ac.patch(`/api/roles/${crypto.randomUUID()}`, { description: 'x' })).status, 404);
  assert.equal((await ac.post('/api/roles', { name: 'Needs MFA', permissions: [], require_mfa: true })).body.error.code, 'MFA_NOT_CONFIGURED', 'cannot require what the server cannot do');
});

test('deleting: a role with people in it is refused; after moving them it can go; built-ins never', async () => {
  const role = (await mkRole('Temporary', [])).role; const { u } = await userWith(role.id, 'temp1');
  const r = await ac.del(`/api/roles/${role.id}`); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'ROLE_IN_USE'); assert.equal(r.body.error.user_count, 1);
  await ac.patch(`/api/users/${u.id}`, { role: 'viewer' });
  assert.equal((await ac.del(`/api/roles/${role.id}`)).status, 200); assert.equal((await ac.get('/api/roles')).body.roles.some(x => x.id === role.id), false);
  for (const id of ['admin', 'trainer', 'technician', 'viewer']) assert.equal((await ac.del(`/api/roles/${id}`)).status, 409, id);
});

test('reset to defaults restores a built-in role; Leader/Admin cannot be reset (it is never changed)', async () => {
  await ac.patch('/api/roles/technician', { permissions: ['equipment.edit', 'training.score', 'training.signoff'] });
  assert.equal((await ac.get('/api/roles')).body.roles.find(r => r.id === 'technician').permissions.includes('training.signoff'), true);
  const r = await ac.post('/api/roles/technician/reset'); assert.equal(r.status, 200);
  assert.deepEqual(r.body.role.permissions, [...require('../../server/lib/permissions').SYSTEM_ROLES.technician.permissions].sort());
  assert.equal((await ac.post('/api/roles/admin/reset')).status, 409); assert.equal((await ac.post('/api/roles/custom/reset')).status, 404, 'unknown role');
});

test('role changes are audited with before/after and who did it', async () => {
  const role = (await mkRole('Audited', ['equipment.edit'])).role; await ac.patch(`/api/roles/${role.id}`, { permissions: ['equipment.edit', 'issues.write'] });
  const log = (await ac.get('/api/audit?limit=50')).body.entries; const upd = log.find(e => e.action === 'role.update' && e.entity_id === role.id);
  assert.ok(log.find(e => e.action === 'role.create' && e.entity_id === role.id)); assert.equal(upd.actor_id, admin.id);
  assert.deepEqual(JSON.parse(upd.detail).before, ['equipment.edit']); assert.deepEqual(JSON.parse(upd.detail).after, ['equipment.edit', 'issues.write']);
});

test('who counts as a trainee follows the role: training.take holders appear in the matrix and can be scored/signed off, others cannot', async () => {
  const withT = (await mkRole('Learner', ['training.take'])).role, without = (await mkRole('Observer', ['issues.write'])).role;
  const a = await h.makeUser(withT.id, 'learner1'), b = await h.makeUser(without.id, 'observer1');
  const matrix = (await ac.get('/api/skill-matrix')).body.users.map(u => u.id); assert.ok(matrix.includes(a.id)); assert.ok(!matrix.includes(b.id));
  const people = (await ac.get('/api/people')).body.people; assert.equal(people.find(p => p.id === a.id).can_train, true); assert.equal(people.find(p => p.id === b.id).can_train, false);
  const m = (await ac.post('/api/modules', { title: 'SAMPLE', level: 1 })).body.module; const sk = (await ac.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE' })).body.id;
  assert.equal((await ac.post('/api/practical-scores', { trainee_id: b.id, skill_id: sk, score: 3 })).body.error.code, 'BAD_TRAINEE');
  assert.equal((await ac.post('/api/practical-scores', { trainee_id: a.id, skill_id: sk, score: 3 })).status, 201);
});

test('self rules survive custom roles: a role with sign-off + score still cannot act on itself, and sign-off still needs approved material', async () => {
  const role = (await mkRole('Lead Trainer', ['training.take', 'training.score', 'training.signoff', 'training.author'])).role; const { u, c } = await userWith(role.id, 'leadtrainer');
  const m = (await c.post('/api/modules', { title: 'SAMPLE self', level: 1 })).body.module; const sk = (await c.post(`/api/modules/${m.id}/skills`, { name: 'S' })).body.id;
  assert.equal((await c.post('/api/practical-scores', { trainee_id: u.id, skill_id: sk, score: 3 })).body.error.code, 'SELF_SCORING');
  assert.equal((await c.post('/api/signoffs', { trainee_id: u.id, module_id: m.id })).body.error.code, 'SELF_SIGNOFF');
});

test('UPGRADE: an existing install (before roles) keeps every account, session and record, and the foreign keys stay intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-upg-')); const file = path.join(dir, 'old.db');
  const old = new Database(file); old.pragma('foreign_keys = ON');
  const mig = path.join(__dirname, '..', '..', 'migrations'), before = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-mig-'));
  for (const f of fs.readdirSync(mig).filter(f => /^00[1-4]_/.test(f))) fs.copyFileSync(path.join(mig, f), path.join(before, f));
  migrate(old, before);                                                          // the database exactly as Phase 5 left it
  const now = new Date().toISOString(), ins = (id, role) => old.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,must_change_password,auth_provider,created_at,updated_at) VALUES (?,?,?,?,?,0,'local',?,?)`).run(id, 'user-' + id, 'U ' + id, role, 'hash', now, now);
  ins('u-admin', 'admin'); ins('u-trainer', 'trainer'); ins('u-tech', 'technician'); ins('u-view', 'viewer');
  old.prepare("INSERT INTO sessions VALUES ('sess-hash','u-tech',?,?,?,NULL)").run(now, now, new Date(Date.now() + 36e5).toISOString());
  old.prepare("INSERT INTO equipment (id,name,status,created_by,updated_by,created_at,updated_at) VALUES ('eq-1','SAMPLE old','draft','u-tech','u-tech',?,?)").run(now, now);
  old.prepare("INSERT INTO training_modules (id,title,level,created_by,updated_by,created_at,updated_at) VALUES ('m-1','SAMPLE m',1,'u-trainer','u-trainer',?,?)").run(now, now);
  old.prepare("INSERT INTO audit_log (ts,actor_id,actor_name,action) VALUES (?,?,?,?)").run(now, 'u-admin', 'user-u-admin', 'old.action');
  old.prepare("INSERT INTO signoffs VALUES ('so-1','u-tech','m-1','u-trainer',90,NULL,?)").run(now);
  const applied = migrate(old); assert.deepEqual(applied, ['005_roles.sql', '006_mfa.sql', '007_signoff_history.sql']);
  assert.deepEqual(old.prepare('SELECT id,role FROM users ORDER BY id').all(), [{ id: 'u-admin', role: 'admin' }, { id: 'u-tech', role: 'technician' }, { id: 'u-trainer', role: 'trainer' }, { id: 'u-view', role: 'viewer' }]);
  assert.equal(old.pragma('foreign_key_check').length, 0, 'no broken foreign keys'); assert.equal(old.pragma('foreign_keys', { simple: true }), 1, 'foreign keys back on');
  assert.equal(old.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1); assert.equal(old.prepare('SELECT created_by FROM equipment').get().created_by, 'u-tech');
  assert.equal(old.prepare('SELECT COUNT(*) n FROM signoffs').get().n, 1); assert.equal(old.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 1);
  assert.throws(() => old.prepare("DELETE FROM signoffs").run(), /append-only/, 'triggers on other tables still work');
  assert.throws(() => old.prepare("UPDATE users SET role='no-such-role' WHERE id='u-tech'").run(), /FOREIGN KEY/, 'role now points at a real role');
  assert.throws(() => old.prepare('DELETE FROM users WHERE id=?').run('u-trainer'), /FOREIGN KEY/, 'users still protected by the tables that reference them');
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='users_new'").get().n, 0);
  assert.deepEqual(migrate(old), [], 'idempotent'); old.close();
  // and the real app opens the upgraded database
  const { createApp } = require('../../server'); const app = createApp({ dbPath: file, uploadDir: path.join(dir, 'up') });
  assert.equal(app.ctx.roles.permissionsOf('trainer').has('training.signoff'), true); assert.equal(app.ctx.roles.permissionsOf('admin').size, KEYS_COUNT()); app.close();
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(before, { recursive: true, force: true });
});

test('a failed role migration changes nothing (all or nothing): existing data damage is detected, not papered over', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  const mig = path.join(__dirname, '..', '..', 'migrations'), part = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-mig2-'));
  for (const f of fs.readdirSync(mig).filter(f => /^00[1-4]_/.test(f))) fs.copyFileSync(path.join(mig, f), path.join(part, f));
  migrate(db, part); const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,must_change_password,auth_provider,created_at,updated_at) VALUES ('u1','a','A','admin','h',0,'local',?,?)`).run(now, now);
  db.pragma('foreign_keys = OFF');                                              // simulate old damage: a record pointing at a person who no longer exists
  db.prepare("INSERT INTO issues (id,kind,title,created_by,updated_by,created_at,updated_at) VALUES ('i1','issue','SAMPLE','ghost','ghost',?,?)").run(now, now); db.pragma('foreign_keys = ON');
  assert.throws(() => migrate(db), /foreign key/i, 'the migration stops instead of continuing over broken data');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('roles','role_permissions','users_new')").get().n, 0, 'nothing was half-applied');
  assert.equal(db.prepare('SELECT role FROM users').get().role, 'admin', 'users are exactly as they were');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are switched back on even after a failure');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name='005_roles.sql'").get().n, 0);
  db.close(); fs.rmSync(part, { recursive: true, force: true });
});
