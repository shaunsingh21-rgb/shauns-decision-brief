'use strict';
// Each test here reproduces a problem found by the pre-launch review team and proves it is fixed.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { harness, PW } = require('../helpers');
const { createApp } = require('../../server');
const { createBackup, restoreBackup } = require('../../scripts/lib/backup');

const closers = []; const mk = async o => { const h = await harness(o); closers.push(h); return h; };
const dirs = []; const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-rf-')); dirs.push(d); return d; };
after(async () => { for (const h of closers) await h.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const ROOT = path.join(__dirname, '..', '..');

test('a mangled cookie or URL escape is "no session" or a 400, never a 500 (and never blocks sign-in)', async () => {
  const h = await mk(); const u = await h.makeUser('technician');
  for (const p of ['/api/me', '/api/equipment']) { const r = await fetch(h.base + p, { headers: { cookie: 'avl_sid=%E0%A4%A' } }); assert.equal(r.status, 401, p); }
  const login = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-by': 'avl-hub', cookie: 'avl_sid=%E0%A4%A' }, body: JSON.stringify({ username: u.username, password: PW }) });
  assert.equal(login.status, 200, 'a person with a broken cookie can still sign in');
  const c = await h.as(u); assert.equal((await c.get('/api/equipment/%E0%A4%A')).status, 400);
  assert.equal((await fetch(h.base + '/api/equipment', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-requested-by': 'avl-hub', cookie: c.cookie }, body: 'not gzip' })).status, 400, 'a broken encoded body is a 400');
});

test('credentials are never kept for replay, and a replay is checked against the CURRENT permissions', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin')); const key = () => 'op-' + crypto.randomUUID();
  const made = await ac.req('POST', '/api/users', { username: 'idem.user', display_name: 'I', role: 'viewer' }, { headers: { 'idempotency-key': key() } });
  assert.equal(made.status, 201); assert.ok(made.body.temporary_password);
  const rs = await ac.req('POST', `/api/users/${made.body.user.id}/reset-password`, {}, { headers: { 'idempotency-key': key() } }); assert.equal(rs.status, 200);
  const dump = JSON.stringify(h.db.prepare('SELECT * FROM idempotency').all()); assert.ok(!dump.includes(made.body.temporary_password) && !dump.includes(rs.body.temporary_password), 'temporary passwords are not in the replay table');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM idempotency').get().n, 0, 'nothing stored for user-management calls');
  // a replay after losing the permission is refused (previously it returned the old success)
  const techRole = h.makeRole(['issues.write'], 'Temp'); const tech = await h.makeUser(techRole, 'demoted'); const tc = await h.as(tech); const k = key();
  assert.equal((await tc.req('POST', '/api/issues', { kind: 'issue', title: 'SAMPLE' }, { headers: { 'idempotency-key': k } })).status, 201);
  assert.equal((await tc.req('POST', '/api/issues', { kind: 'issue', title: 'SAMPLE' }, { headers: { 'idempotency-key': k } })).headers, undefined);
  h.db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(techRole);
  assert.equal((await tc.req('POST', '/api/issues', { kind: 'issue', title: 'SAMPLE' }, { headers: { 'idempotency-key': k } })).status, 403, 'no stored success for someone who may no longer do it');
});

test('a session ends after its absolute lifetime even if used every day', async () => {
  const h = await mk({ sessionMaxDays: 14 }); const u = await h.makeUser('technician'); const c = await h.as(u);
  assert.equal((await c.get('/api/me')).status, 200);
  h.db.prepare('UPDATE sessions SET created_at=?').run(new Date(Date.now() - 15 * 864e5).toISOString());
  assert.equal((await c.get('/api/me')).status, 401, 'too old, however recently it was used');
});

test('a tab that thinks it is someone else is refused instead of acting as the wrong person (SESSION_CHANGED)', async () => {
  const h = await mk(); const a = await h.makeUser('trainer', 'alicia'), b = await h.makeUser('technician', 'bobby'); const bc = await h.as(b);
  const stale = await bc.req('POST', '/api/issues', { kind: 'issue', title: 'x' }, { headers: { 'x-acting-user': a.id } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'SESSION_CHANGED'); assert.equal(h.db.prepare('SELECT COUNT(*) n FROM issues').get().n, 0, 'nothing was done');
  assert.equal((await bc.req('POST', '/api/issues', { kind: 'issue', title: 'x' }, { headers: { 'x-acting-user': b.id } })).status, 201);
  assert.equal((await bc.req('GET', '/api/equipment', undefined, { headers: { 'x-acting-user': a.id } })).status, 409, 'reads too');
});

test('a role that requires two-step fails closed when the server has no key; only a Leader/Admin may change the requirement', async () => {
  const h0 = await mk({ mfaEncryptionKey: null }); const role = h0.makeRole(['equipment.edit'], 'Needs MFA', { requireMfa: true }); const c = await h0.as(await h0.makeUser(role));
  assert.equal((await c.get('/api/me')).status, 200); const r = await c.get('/api/equipment'); assert.equal(r.status, 503); assert.equal(r.body.error.code, 'MFA_UNAVAILABLE');
  const h = await mk({ mfaEncryptionKey: 'ab12'.repeat(16) }); const mgr = await h.as(await h.makeUser(h.makeRole(['roles.manage', 'equipment.edit'], 'Role Steward'), 'steward')); const ac = await h.as(await h.makeUser('admin'));
  assert.equal((await mgr.post('/api/roles', { name: 'Sneaky', permissions: ['equipment.edit'], require_mfa: true })).status, 403);
  const made = (await mgr.post('/api/roles', { name: 'Fine', permissions: ['equipment.edit'] })).body.role; assert.equal((await mgr.patch(`/api/roles/${made.id}`, { require_mfa: true })).body.error.code, 'TOO_POWERFUL');
  assert.equal((await ac.patch(`/api/roles/${made.id}`, { require_mfa: true })).status, 200); assert.equal((await mgr.patch(`/api/roles/${made.id}`, { require_mfa: false })).status, 403, 'and a manager cannot switch it off again');
  assert.equal((await mgr.patch(`/api/roles/${made.id}`, { description: 'unrelated edit that leaves the requirement alone' })).status, 200);
});

test('creating the same username at the same moment gives one account and clean 409s', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin'));
  const rs = await Promise.all(Array.from({ length: 6 }, () => ac.post('/api/users', { username: 'twin.user', display_name: 'T', role: 'viewer' })));
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 409, 409, 409, 409, 409]); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM users WHERE username='twin.user'").get().n, 1);
});

test('IMPORT/EXPORT respect the permissions behind them: data.manage alone adds nothing, and quiz answers only go to people who may see them', async () => {
  const A = await mk(); const aa = await A.as(await A.makeUser('admin')); const tcA = await A.as(await A.makeUser('trainer'));
  await aa.post('/api/sources', { domain: 'example-maker.com' });
  const e = (await aa.post('/api/equipment', { name: 'SAMPLE', fields: [] })).body.equipment; const m = (await tcA.post('/api/modules', { title: 'SAMPLE m', level: 1, equipment_id: e.id })).body.module;
  await tcA.post(`/api/modules/${m.id}/questions`, { prompt: 'SAMPLE q', options: ['a', 'b'], correct_index: 1 });
  const dataOnly = await A.as(await A.makeUser(A.makeRole(['data.manage'], 'Data Only'), 'dataonly'));
  const full = (await aa.get('/api/admin/export')).body; assert.equal(full.modules[0].questions[0].correct_index, 1);
  const lean = (await dataOnly.get('/api/admin/export')).body; assert.deepEqual(lean.modules[0].questions, [], 'no answers for someone who may not see them'); assert.match(lean.note, /left out/);
  const B = await mk(); await B.makeUser('admin');                     // an instance always has an administrator (the import refuses otherwise)
  const bOnly = await B.as(await B.makeUser(B.makeRole(['data.manage'], 'Data Only')));
  const before = B.db.prepare('SELECT (SELECT COUNT(*) FROM source_domains)+(SELECT COUNT(*) FROM equipment)+(SELECT COUNT(*) FROM training_modules) n').get().n;
  const denied = await bOnly.post('/api/admin/import', { data: full }); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'IMPORT_NEEDS_PERMISSION');
  assert.ok(denied.body.error.missing.length >= 3); assert.equal((await bOnly.post('/api/admin/import', { data: full, dry_run: true })).status, 403, 'even a dry run');
  assert.equal(B.db.prepare('SELECT (SELECT COUNT(*) FROM source_domains)+(SELECT COUNT(*) FROM equipment)+(SELECT COUNT(*) FROM training_modules) n').get().n, before, 'nothing was added');
  const partial = await B.as(await B.makeUser(B.makeRole(['data.manage', 'equipment.edit', 'sources.manage', 'training.author'], 'Importer'))); assert.equal((await partial.post('/api/admin/import', { data: full })).status, 200, 'with each permission it works');
});

test('deleting equipment removes its panels, unlinks modules and hides its updates; pins on a deleted panel change nothing', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin')); const tc = await h.as(await h.makeUser('trainer'));
  const e = (await ac.post('/api/equipment', { name: 'SAMPLE doomed', fields: [] })).body.equipment;
  const file = (await ac.upload({ purpose: 'photo' }, PNG, 'p.png')).body.file; const panel = (await ac.post('/api/panels', { equipment_id: e.id, title: 'SAMPLE', file_id: file.id })).body.panel;
  const pin = (await ac.post(`/api/panels/${panel.id}/pins`, { x: 0.1, y: 0.1, provenance: 'team', label: 'ORIGINAL' })).body.panel.pins[0];
  const mod = (await tc.post('/api/modules', { title: 'SAMPLE', level: 1, equipment_id: e.id })).body.module; await ac.post('/api/updates', { equipment_id: e.id, kind: 'firmware', available_version: 'SAMPLE-1' });
  assert.equal((await ac.del(`/api/equipment/${e.id}`)).status, 200);
  assert.equal((await ac.get('/api/panels')).body.panels.length, 0); assert.equal((await ac.get(`/api/panels/${panel.id}`)).status, 404); assert.equal((await ac.post(`/api/panels/${panel.id}/approve`, {})).status, 404);
  assert.equal((await ac.get('/api/updates')).body.updates.length, 0); assert.equal(h.db.prepare('SELECT equipment_id FROM training_modules WHERE id=?').get(mod.id).equipment_id, null);
  assert.equal((await ac.req('PATCH', `/api/pins/${pin.id}`, { x: 0.5, y: 0.5, provenance: 'team', label: 'CHANGED' })).status, 404);
  assert.equal(h.db.prepare('SELECT label FROM panel_pins WHERE id=?').get(pin.id).label, 'ORIGINAL', 'the refused edit changed nothing');
  assert.equal((await ac.del(`/api/pins/${pin.id}`)).status, 404); assert.ok(h.db.prepare('SELECT 1 FROM panel_pins WHERE id=?').get(pin.id), 'and the refused delete removed nothing');
  assert.equal((await tc.del(`/api/files/${file.id}`)).status, 200, 'the photo is no longer held by a live panel, so it can be deleted');
});

test('uploads: the size limit follows the stated purpose while the file is still arriving; the purpose must be stated and consistent; leftovers are swept at start-up', async () => {
  const h = await mk({ maxPhotoMb: 1, maxVideoMb: 5 }); const c = await h.as(await h.makeUser('technician')); const big = Buffer.concat([PNG, Buffer.alloc(2 * 1048576)]);
  const r = await c.upload({ purpose: 'photo' }, big, 'big.png'); assert.equal(r.status, 413); assert.deepEqual(fs.readdirSync(path.join(h.ctx.config.uploadDir, '_tmp')), [], 'nothing left behind');
  const form = (qs, bodyPurpose) => { const fd = new FormData(); if (bodyPurpose) fd.append('purpose', bodyPurpose); fd.append('file', new Blob([PNG]), 'a.png'); return fetch(h.base + '/api/files' + qs, { method: 'POST', body: fd, headers: { 'x-requested-by': 'avl-hub', cookie: c.cookie } }); };
  assert.equal((await form('', 'photo')).status, 400, 'no ?purpose='); assert.equal((await form('?purpose=photo', 'document')).status, 400, 'query and body disagree'); assert.equal((await form('?purpose=exe', 'exe')).status, 400); assert.equal((await form('?purpose=photo', 'photo')).status, 201);
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'up', '_tmp'), { recursive: true }); fs.writeFileSync(path.join(dir, 'up', '_tmp', 'crashed-upload'), 'partial'); const app = createApp({ dbPath: path.join(dir, 'a.db'), uploadDir: path.join(dir, 'up') });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'up', '_tmp')), [], 'a partial upload from a crash is removed at start-up'); app.close();
});

test('backups are private to their owner (folder 700, files 600)', async () => {
  const h = await mk(); await h.makeUser('admin'); const bk = tmp(); const r = await createBackup({ dbPath: h.ctx.config.dbPath, uploadDir: h.ctx.config.uploadDir, backupDir: bk });
  const mode = p => fs.statSync(p).mode & 0o777; assert.equal(mode(bk), 0o700); assert.equal(mode(r.dir), 0o700); assert.equal(mode(path.join(r.dir, 'avl-hub.db')), 0o600); assert.equal(mode(path.join(r.dir, 'manifest.json')), 0o600);
});

test('RESTORE REFUSES while the app is running (heartbeat), and proceeds once it has stopped', async () => {
  const h = await mk(); await h.makeUser('admin'); const bk = tmp(); const { dir } = await createBackup({ dbPath: h.ctx.config.dbPath, uploadDir: h.ctx.config.uploadDir, backupDir: bk });
  const { dbPath, uploadDir } = h.ctx.config; await h.close(true); const beat = path.join(path.dirname(dbPath), '.avl-running'); dirs.push(h.dir);
  fs.writeFileSync(beat, String(Date.now()));
  assert.throws(() => restoreBackup({ backupPath: dir, dbPath, uploadDir }), /appears to be running/); assert.ok(fs.existsSync(dbPath), 'nothing was moved');
  const old = new Date(Date.now() - 60000); fs.utimesSync(beat, old, old);
  assert.doesNotThrow(() => restoreBackup({ backupPath: dir, dbPath, uploadDir }), 'a stale heartbeat (app stopped) does not block it');
});

test('the real server stops cleanly on SIGTERM, signals that it is running, and removes the signal', async () => {
  const d = tmp(), port = 4300 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, AVL_NO_ENV_FILE: '1', NODE_ENV: 'development', PORT: String(port), DB_PATH: path.join(d, 'a.db'), UPLOAD_DIR: path.join(d, 'up') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { out += x; });
  for (let i = 0; i < 50 && !/listening/.test(out); i++) await new Promise(r => setTimeout(r, 100)); assert.match(out, /listening/);
  const beat = path.join(d, '.avl-running'); assert.ok(fs.existsSync(beat), 'heartbeat is written while running'); assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  const exited = new Promise(r => child.on('exit', (code, sig) => r({ code, sig }))); child.kill('SIGTERM');
  const res = await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 8000))]); assert.notEqual(res, 'timeout', 'stopped promptly'); assert.equal(res.code, 0, `exit code (${out})`); assert.ok(!fs.existsSync(beat), 'signal removed on a clean stop'); assert.match(out, /SIGTERM received/);
});

test('every helper script reads the same .env as the server; real environment variables still win', async () => {
  const d = tmp(), envFile = path.join(d, 'test.env');
  fs.writeFileSync(envFile, `# comment\nMFA_ENCRYPTION_KEY="${'cd34'.repeat(16)}"\nSHAREPOINT_HOSTS=tenant.sharepoint.com\nBRAVE_API_KEY=\nSESSION_TTL_HOURS=7\nPORT=1234\n`);
  const run = env => JSON.parse(spawnSync(process.execPath, ['-e', "const c=require('./server/config')();console.log(JSON.stringify({k:c.mfaEncryptionKey&&c.mfaEncryptionKey.slice(0,4),h:c.sharepointHosts,b:c.braveApiKey,t:c.sessionTtlHours,p:c.port}))"], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).stdout);
  assert.deepEqual(run({ ENV_FILE: envFile }), { k: 'cd34', h: ['tenant.sharepoint.com'], b: null, t: 7, p: 1234 });
  assert.equal(run({ ENV_FILE: envFile, PORT: '9999' }).p, 9999, 'an environment variable overrides the file'); assert.equal(run({ ENV_FILE: envFile, AVL_NO_ENV_FILE: '1' }).k, null, 'and the file can be skipped');
  assert.equal(run({ ENV_FILE: path.join(d, 'missing.env') }).k, null, 'a missing file is fine');
});

test('the audit log names who and what, supports paging, and the backup status is available to the Admin screen', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin', 'boss')); await ac.post('/api/users', { username: 'new.person', display_name: 'N', role: 'viewer' }); const role = (await ac.post('/api/roles', { name: 'Named Role', permissions: [] })).body.role;
  const e = (await ac.post('/api/equipment', { name: 'SAMPLE Named Thing', fields: [] })).body.equipment;
  const log = (await ac.get('/api/audit?limit=50')).body; const t = a => log.entries.find(x => x.action === a).target;
  assert.equal(t('user.create'), 'new.person'); assert.equal(t('role.create'), 'Named Role'); assert.equal(t('equipment.create'), 'SAMPLE Named Thing'); assert.equal(typeof log.has_more, 'boolean');
  const page1 = (await ac.get('/api/audit?limit=2')).body; assert.equal(page1.has_more, true); const page2 = (await ac.get(`/api/audit?limit=2&before=${page1.entries.at(-1).id}`)).body; assert.ok(page2.entries[0].id < page1.entries.at(-1).id); void role; void e;
  const none = (await ac.get('/api/admin/backup-status')).body; assert.deepEqual([none.count, none.newest, none.healthy], [0, null, false]);
  const bk = h.ctx.config.backupDir; fs.mkdirSync(bk, { recursive: true }); const stamp = new Date(Date.now() - 3 * 3600e3).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-'); fs.mkdirSync(path.join(bk, `avl-backup-${stamp}`));
  const some = (await ac.get('/api/admin/backup-status')).body; assert.equal(some.count, 1); assert.ok(some.age_hours > 2.9 && some.age_hours < 3.2); assert.equal(some.healthy, true); fs.rmSync(path.join(bk, `avl-backup-${stamp}`), { recursive: true });
});

test('the request limit is per PERSON (a team behind one office address does not share it), and successful sign-ins do not use up the sign-in allowance', async () => {
  const h = await mk({ apiRateMax: 6, loginIpMax: 3 }); const a = await h.as(await h.makeUser('technician')), b = await h.as(await h.makeUser('technician'));
  for (let i = 0; i < 6; i++) assert.equal((await a.get('/api/me')).status, 200); assert.equal((await a.get('/api/me')).status, 429, 'person A used their allowance');
  assert.equal((await b.get('/api/me')).status, 200, 'person B, same address, is unaffected');
  const h2 = await mk({ loginIpMax: 3 }); const u = await h2.makeUser('technician', 'manylogins'); for (let i = 0; i < 6; i++) assert.equal((await h2.client().login(u)).status, 200, `sign-in ${i + 1}`);
  const c = h2.client(); for (let i = 0; i < 3; i++) await c.login('nobody-here', 'wrong-password-12'); assert.equal((await c.login('nobody-here', 'wrong-password-12')).body.error.code, 'RATE_LIMITED', 'but failures still count');
});

test('file names with accents or non-English letters are kept as typed (they used to come out garbled)', async () => {
  const h = await mk(); const c = await h.as(await h.makeUser('technician'));
  for (const name of ['café-é.png', 'Übersicht.png', 'マニュアル.png', 'plain.png']) { const r = await c.upload({ purpose: 'photo' }, PNG, name); assert.equal(r.status, 201); assert.equal(r.body.file.name, name); }
  const evil = (await c.upload({ purpose: 'photo' }, PNG, '../../etc/passwd\r\n<script>.png')).body.file.name; assert.ok(!/[\\/<>\r\n]/.test(evil), 'still sanitised: ' + evil);
});
