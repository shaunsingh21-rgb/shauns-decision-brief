'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { harness } = require('../helpers');
const { createBackup, verifyBackup, restoreBackup, listBackups, prune } = require('../../scripts/lib/backup');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const tmpDirs = []; const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-bk-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const names = h => h.db.prepare('SELECT name FROM equipment ORDER BY name').all().map(r => r.name);
const dbNames = file => { const d = new Database(file, { readonly: true }); try { return d.prepare('SELECT name FROM equipment ORDER BY name').all().map(r => r.name); } finally { d.close(); } };
// a live app with an admin, some data, and one uploaded photo
async function liveApp() {
  const h = await harness(); tmpDirs.push(h.dir); const admin = await h.makeUser('admin'), tech = await h.makeUser('technician'); const kc = await h.as(tech);
  await kc.post('/api/equipment', { name: 'SAMPLE before backup', fields: [] });
  const file = (await kc.upload({ purpose: 'photo' }, PNG, 'p.png')).body.file;
  return { h, admin, kc, file };
}

test('backup is safe while the app is running, verifies itself, and includes the database and every uploaded file', async () => {
  const { h, kc, file } = await liveApp(); const backupDir = tmp();
  const w = setInterval(() => { try { h.db.prepare("INSERT INTO audit_log (ts,action) VALUES (?, 'noise')").run(new Date().toISOString()); } catch {} }, 1);   // writes happening during the backup
  const r = await createBackup({ dbPath: h.ctx.config.dbPath, uploadDir: h.ctx.config.uploadDir, backupDir }); clearInterval(w);
  assert.match(path.basename(r.dir), /^avl-backup-\d{8}-\d{6}$/);
  assert.equal(r.manifest.file_count, 1); assert.equal(r.manifest.active_admins, 1);
  assert.ok(fs.readFileSync(path.join(r.dir, 'files', file.id)).equals(PNG));
  const v = verifyBackup(r.dir); assert.equal(v.ok, true, v.problems.join(' '));
  assert.ok(!fs.readdirSync(backupDir).some(n => n.endsWith('.partial')), 'no half-finished backup is left behind');
  assert.deepEqual(dbNames(path.join(r.dir, 'avl-hub.db')), ['SAMPLE before backup']);
  await h.close();
});

test('RESTORE brings back the data from the backup, keeps the newer data aside (never deletes it), and the app works afterwards', async () => {
  const { h, kc, file } = await liveApp(); const backupDir = tmp();
  const { dir } = await createBackup({ dbPath: h.ctx.config.dbPath, uploadDir: h.ctx.config.uploadDir, backupDir });
  await kc.post('/api/equipment', { name: 'SAMPLE after backup (will be rolled back)', fields: [] });
  const file2 = (await kc.upload({ purpose: 'photo' }, Buffer.concat([PNG, Buffer.alloc(8, 9)]), 'q.png')).body.file;
  const { dbPath, uploadDir } = h.ctx.config; await h.close(true);                                // the app must be stopped to restore
  const res = restoreBackup({ backupPath: dir, dbPath, uploadDir });
  assert.deepEqual(dbNames(dbPath), ['SAMPLE before backup']);
  assert.ok(fs.existsSync(path.join(uploadDir, 'files', file.id)) && !fs.existsSync(path.join(uploadDir, 'files', file2.id)), 'uploaded files match the backup');
  assert.ok(res.previous_data_kept_at && fs.existsSync(res.previous_data_kept_at), 'the newer data was kept, not deleted');
  assert.deepEqual(dbNames(path.join(res.previous_data_kept_at, path.basename(dbPath))), ['SAMPLE after backup (will be rolled back)', 'SAMPLE before backup']);
  assert.ok(fs.existsSync(path.join(res.previous_data_kept_at, 'files', file2.id)));
  const { createApp } = require('../../server'); const again = createApp({ dbPath, uploadDir });      // the real app opens the restored data and works
  assert.equal(again.ctx.db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n, 1); again.close();
});

test('restore refuses damaged, incomplete, admin-less, or too-new backups — and says why', async () => {
  const { h } = await liveApp(); const backupDir = tmp(); const cfg = h.ctx.config;
  const good = await createBackup({ dbPath: cfg.dbPath, uploadDir: cfg.uploadDir, backupDir, now: new Date(Date.UTC(2026, 0, 1)) });
  // 1. tampered database
  const t = path.join(backupDir, 'tampered'); fs.cpSync(good.dir, t, { recursive: true }); fs.appendFileSync(path.join(t, 'avl-hub.db'), 'junk');
  assert.match(verifyBackup(t).problems.join(), /checksum/);
  // 2. missing manifest / not a backup
  const m = path.join(backupDir, 'nomanifest'); fs.cpSync(good.dir, m, { recursive: true }); fs.rmSync(path.join(m, 'manifest.json'));
  assert.match(verifyBackup(m).problems.join(), /not a complete/); assert.equal(verifyBackup(tmp()).ok, false);
  // 3. a missing uploaded file
  const f = path.join(backupDir, 'missingfile'); fs.cpSync(good.dir, f, { recursive: true }); fs.rmSync(path.join(f, 'files'), { recursive: true });
  assert.match(verifyBackup(f).problems.join(), /uploaded files/);
  // 4. no active administrator
  h.db.prepare("UPDATE users SET disabled=1 WHERE role='admin'").run();
  const noAdmin = await createBackup({ dbPath: cfg.dbPath, uploadDir: cfg.uploadDir, backupDir, now: new Date(Date.UTC(2026, 0, 2)) });
  const v = verifyBackup(noAdmin.dir); assert.equal(v.ok, false); assert.match(v.problems.join(), /no active administrator/);
  assert.throws(() => restoreBackup({ backupPath: noAdmin.dir, dbPath: path.join(tmp(), 'x.db'), uploadDir: tmp() }), /no active administrator/);
  h.db.prepare("UPDATE users SET disabled=0 WHERE role='admin'").run();
  // 5. from a NEWER version of the app
  h.db.prepare("INSERT INTO schema_migrations VALUES ('999_from_the_future.sql', ?)").run(new Date().toISOString());
  const newer = await createBackup({ dbPath: cfg.dbPath, uploadDir: cfg.uploadDir, backupDir, now: new Date(Date.UTC(2026, 0, 3)) });
  assert.match(verifyBackup(newer.dir).problems.join(), /NEWER version/);
  assert.equal(verifyBackup(good.dir).ok, true, 'the good one is still fine');
  await h.close();
});

test('a failure part-way through restore puts the original data back exactly as it was', async () => {
  const { h, kc } = await liveApp(); const backupDir = tmp(); const { dbPath, uploadDir } = h.ctx.config;
  const { dir } = await createBackup({ dbPath, uploadDir, backupDir });
  await kc.post('/api/equipment', { name: 'SAMPLE current data', fields: [] }); await h.close(true);
  const real = fs.cpSync; fs.cpSync = () => { throw new Error('disk full (simulated)'); };
  try { assert.throws(() => restoreBackup({ backupPath: dir, dbPath, uploadDir }), /disk full/); } finally { fs.cpSync = real; }
  assert.deepEqual(dbNames(dbPath), ['SAMPLE before backup', 'SAMPLE current data'], 'current data is back, untouched');
  assert.equal(fs.readdirSync(path.join(uploadDir, 'files')).length, 1);
});

test('restore refuses while the app still has the database open', async () => {
  const { h } = await liveApp(); const backupDir = tmp(); const { dbPath, uploadDir } = h.ctx.config;
  const { dir } = await createBackup({ dbPath, uploadDir, backupDir });
  h.db.exec('BEGIN IMMEDIATE');                                               // a write in progress, like a running app
  try { assert.throws(() => restoreBackup({ backupPath: dir, dbPath, uploadDir }), /in use|Stop the app/); } finally { h.db.exec('ROLLBACK'); }
  await h.close();
});

test('retention keeps the newest N backups, removes only our own backup folders, and lists them in order', async () => {
  const { h } = await liveApp(); const backupDir = tmp(); const cfg = h.ctx.config;
  fs.mkdirSync(path.join(backupDir, 'my-notes')); fs.writeFileSync(path.join(backupDir, 'readme.txt'), 'keep me');
  for (let d = 1; d <= 5; d++) await createBackup({ dbPath: cfg.dbPath, uploadDir: cfg.uploadDir, backupDir, keep: 3, now: new Date(Date.UTC(2026, 0, d, 2, 0, 0)) });
  assert.deepEqual(listBackups(backupDir), ['avl-backup-20260103-020000', 'avl-backup-20260104-020000', 'avl-backup-20260105-020000']);
  assert.ok(fs.existsSync(path.join(backupDir, 'my-notes')) && fs.existsSync(path.join(backupDir, 'readme.txt')), 'unrelated files are never touched');
  assert.deepEqual(prune(backupDir, 0).length, 2, 'keep is never below 1: the newest is always retained'); assert.equal(listBackups(backupDir).length, 1);
  await assert.rejects(createBackup({ dbPath: path.join(backupDir, 'nope.db'), uploadDir: cfg.uploadDir, backupDir }), /not found/);
  await h.close();
});

test('command line: backup exits 0 and reports; fails loudly (non-zero) when it cannot; restore needs the backup; doctor flags problems in plain words', async () => {
  const { h } = await liveApp(); const cfg = h.ctx.config, backupDir = tmp(), copyTo = tmp();
  const env = { ...process.env, DB_PATH: cfg.dbPath, UPLOAD_DIR: cfg.uploadDir, BACKUP_DIR: backupDir, BACKUP_KEEP: '5', BACKUP_COPY_TO: path.join(copyTo, 'offsite'), BRAVE_API_KEY: 'SECRET-DO-NOT-PRINT-123', NODE_ENV: '' };
  const root = path.join(__dirname, '..', '..'), run = (script, args = [], e = env) => spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { env: e, encoding: 'utf8' });
  const ok = run('backup.js'); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /^OK /); assert.match(ok.stdout, /copied to/);
  assert.equal(fs.readdirSync(path.join(copyTo, 'offsite')).length, 1, 'the optional second copy was made');
  const sh = spawnSync(path.join(root, 'scripts', 'backup.sh'), { env: { ...env, BACKUP_COPY_TO: '' }, encoding: 'utf8' }); assert.equal(sh.status, 0, sh.stderr);
  assert.match(fs.readFileSync(path.join(backupDir, 'backup.log'), 'utf8'), /^OK /m);
  const fail = run('backup.js', [], { ...env, DB_PATH: path.join(backupDir, 'missing.db') }); assert.equal(fail.status, 1); assert.match(fail.stderr, /BACKUP FAILED: Database not found/);
  const noArg = run('restore.js'); assert.equal(noArg.status, 2); assert.match(noArg.stderr, /Usage/);
  const doc = run('doctor.js'); assert.equal(doc.status, 0, doc.stdout); assert.match(doc.stdout, /1 active administrator/); assert.match(doc.stdout, /Newest backup is under an hour old/);
  assert.ok(!doc.stdout.includes('SECRET-DO-NOT-PRINT') && !doc.stderr.includes('SECRET-DO-NOT-PRINT'), 'doctor never prints secrets'); assert.match(doc.stdout, /web search key is set/i);
  h.db.prepare("UPDATE users SET disabled=1 WHERE role='admin'").run();
  const bad = run('doctor.js'); assert.equal(bad.status, 1); assert.match(bad.stdout, /No administrator exists yet.*create-admin/);
  const empty = run('doctor.js', [], { ...env, DB_PATH: path.join(tmp(), 'fresh.db'), BACKUP_DIR: tmp() }); assert.equal(empty.status, 1); assert.match(empty.stdout, /No backups found/);
  const verbose = run('restore.js', [path.join(backupDir, listBackups(backupDir)[0]), '--yes']);       // app (this process) still holds the db open? it is idle, so restore must succeed or refuse cleanly
  assert.ok([0, 1].includes(verbose.status));
  await h.close();
});

test('emergency password reset (server access only): unlocks, re-enables, forces a change, signs out, audits; refuses SSO accounts and weak passwords', async () => {
  const h = await harness(); tmpDirs.push(h.dir); const u = await h.makeUser('admin', 'lockedout'); const root = path.join(__dirname, '..', '..');
  const env = { ...process.env, DB_PATH: h.ctx.config.dbPath, UPLOAD_DIR: h.ctx.config.uploadDir, NODE_ENV: '' }; const run = (args, e = {}) => spawnSync(process.execPath, [path.join(root, 'scripts', 'reset-password.js'), ...args], { env: { ...env, ...e }, encoding: 'utf8' });
  const c = h.client(); for (let i = 0; i < 3; i++) await c.login('lockedout', 'bad-password-1234'); assert.equal((await c.login(u)).status, 429);
  const live = await h.as(await h.makeUser('viewer', 'other')); void live;
  h.db.prepare("UPDATE users SET disabled=1 WHERE username='lockedout'").run();
  assert.equal(run(['nobody'], { AVL_NEW_PASSWORD: 'A-new-temporary-pass-9' }).status, 1);
  assert.equal(run(['lockedout'], { AVL_NEW_PASSWORD: 'short' }).status, 1, 'weak password refused');
  assert.equal(run([]).status, 2);
  const ok = run(['lockedout'], { AVL_NEW_PASSWORD: 'A-new-temporary-pass-9' }); assert.equal(ok.status, 0, ok.stderr);
  const r = await h.client().login('lockedout', 'A-new-temporary-pass-9'); assert.equal(r.status, 200); assert.equal(r.body.user.must_change_password, true);
  assert.equal((await h.client().login('lockedout', PW_OLD)).status, 401, 'old password no longer works');
  const log = h.db.prepare("SELECT * FROM audit_log WHERE action='user.reset_password_cli'").get(); assert.equal(log.actor_name, 'cli'); assert.ok(!log.detail.includes('A-new-temporary'));
  h.db.prepare("UPDATE users SET auth_provider='oidc', external_subject='abc', password_hash=NULL WHERE username='other'").run();
  assert.equal(run(['other'], { AVL_NEW_PASSWORD: 'A-new-temporary-pass-9' }).status, 1, 'SSO accounts have no local password to reset');
  await h.close();
});
const PW_OLD = 'Sample-Passw0rd-123';
