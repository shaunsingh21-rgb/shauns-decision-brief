'use strict';
// Support bundle:  npm run support-bundle        (Docker: docker compose exec -T app node scripts/support-bundle.js --stdout > support.txt)
// Collects what a developer needs to diagnose a problem, in ONE text file you can email or paste. It NEVER contains passwords, keys, cookies,
// the contents of the database, people's names or addresses. Secrets in .env are shown only as "set" / "not set". Read it before sending if you like.
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const loadConfig = require('../server/config');
const { open } = require('../server/db');
const support = require('../server/lib/support');
const { listBackups, backupAgeHours, verifyBackup } = require('./lib/backup');
const c = loadConfig(), out = [], H = t => out.push(`\n===== ${t} =====`), L = (...a) => out.push(a.join(' '));
const tryit = (label, fn) => { try { fn(); } catch (e) { L(`(${label} failed: ${support.scrub(support.explainError(e).short)})`); } };

const b = support.buildInfo();
L(`AVL Hub support bundle  -  made ${new Date().toISOString()} (server clock)`);
H('Version'); L(`app ${b.version}  commit ${b.commit}  built ${b.built_at || 'unknown'}`); L(`node ${process.versions.node}  ${os.platform()} ${os.release()} ${os.arch()}  uptime ${(os.uptime() / 3600).toFixed(1)} h  load ${os.loadavg().map(x => x.toFixed(2)).join(' ')}  mem free ${(os.freemem() / 1e9).toFixed(1)}/${(os.totalmem() / 1e9).toFixed(1)} GB`);
L(`timezone ${Intl.DateTimeFormat().resolvedOptions().timeZone}  TZ=${process.env.TZ || '(unset)'}`);

H('Settings (secrets are never shown)');
const SECRET = new Set(['MFA_ENCRYPTION_KEY', 'BRAVE_API_KEY', 'ANTHROPIC_API_KEY']);
for (const k of support.KNOWN_KEYS.filter(k => !['ENV_FILE', 'AVL_NO_ENV_FILE'].includes(k))) { const v = process.env[k]; L(`${k.padEnd(26)} ${v === undefined || v === '' ? '(not set)' : SECRET.has(k) ? 'set (hidden)' : /^(DB_PATH|UPLOAD_DIR|BACKUP_DIR|BACKUP_COPY_TO|LOG_DIR|OFFSITE_DIR)$/.test(k) ? v : v}`); }
L(`MFA key valid: ${(() => { if (!c.mfaEncryptionKey) return 'n/a (not set)'; try { require('../server/lib/totp').keyBuf(c.mfaEncryptionKey); return 'yes'; } catch { return 'NO - not 64 hex characters'; } })()}`);
const envFile = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
tryit('.env check', () => { if (!fs.existsSync(envFile)) { L(`.env: no file at ${envFile} (normal under Docker, which passes settings in directly)`); return; }
  const probs = support.lintEnvText(fs.readFileSync(envFile, 'utf8')); L(`.env file problems: ${probs.length || 'none'}`); for (const p of probs) L(`  line ${p.line}: ${p.msg}`);
  const m = fs.statSync(envFile).mode & 0o777; if (m & 0o077) L(`  .env is readable by other users (mode ${m.toString(8)}): run  chmod 600 ${envFile}`); });

let db = null;
H('Database');
tryit('database', () => {
  L(`file ${c.dbPath}  ${fs.existsSync(c.dbPath) ? (fs.statSync(c.dbPath).size / 1048576).toFixed(1) + ' MB' : 'MISSING'}  wal ${fs.existsSync(c.dbPath + '-wal') ? (fs.statSync(c.dbPath + '-wal').size / 1048576).toFixed(1) + ' MB' : 'none'}`);
  db = open(c.dbPath);                                            // opens only; the bundle never runs migrations
  const s = support.schemaInfo(db); L(`schema: latest applied ${s.latest_applied}; this app expects ${s.latest_known}; applied ${s.applied}/${s.known}`);
  if (s.newer_than_this_app.length) L(`  !! database is NEWER than this app: ${s.newer_than_this_app.join(', ')}`); if (s.pending.length) L(`  pending migrations: ${s.pending.join(', ')}`);
  L(`quick_check: ${db.pragma('quick_check', { simple: true })}   foreign_key_check problems: ${db.pragma('foreign_key_check').length}`);
  const n = t => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return '?'; } };
  L(`rows: users ${n('users')} (active admins ${db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n}), equipment ${n('equipment')}, modules ${n('training_modules')}, sign-offs ${n('signoffs')}, files ${n('files')}, audit ${n('audit_log')}, sessions ${n('sessions')}, mfa-enrolled ${db.prepare('SELECT COUNT(*) n FROM user_mfa WHERE enabled_at IS NOT NULL').get().n}`);
  L('last 15 audit actions (action names and times only; no people, no details):');
  for (const r of db.prepare('SELECT ts, action FROM audit_log ORDER BY id DESC LIMIT 15').all()) L(`  ${r.ts}  ${r.action}`);
  L('recent failed or blocked sign-ins (24 h): ' + db.prepare("SELECT COUNT(*) n FROM audit_log WHERE ts > ? AND action IN ('auth.login_failed','auth.lockout','auth.login_blocked_locked')").get(new Date(Date.now() - 864e5).toISOString()).n);
});

H('Uploaded files');
tryit('uploads', () => {
  const dir = path.join(c.uploadDir, 'files'); const onDisk = fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : null;
  L(`folder ${c.uploadDir}  ${onDisk ? onDisk.size + ' files on disk' : 'FOLDER MISSING'}`);
  if (db && onDisk) { const rows = db.prepare('SELECT id FROM files WHERE deleted_at IS NULL').all(); const missing = rows.filter(r => !onDisk.has(r.id)); L(`files the database lists: ${rows.length}; MISSING from disk: ${missing.length}` + (missing.length ? `  (first ids: ${missing.slice(0, 5).map(r => r.id).join(', ')})` : '')); }
  try { const p = path.join(c.uploadDir, '_tmp', '.bundle-probe'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); fs.rmSync(p); L('uploads folder writable: yes'); } catch (e) { L('uploads folder writable: NO - ' + e.code); }
});

H('Disk and backups');
tryit('disk', () => { const s = fs.statfsSync(path.dirname(c.dbPath)); L(`data disk free ${(s.bavail * s.bsize / 1e9).toFixed(1)} GB of ${(s.blocks * s.bsize / 1e9).toFixed(1)} GB`); });
tryit('backups', () => {
  const names = listBackups(c.backupDir); L(`backup folder ${c.backupDir}: ${names.length} backup(s)`);
  for (const nme of names.slice(-5)) L(`  ${nme}  ${backupAgeHours(nme).toFixed(0)} h old`);
  if (names.length) { const v = verifyBackup(path.join(c.backupDir, names.at(-1))); L(`newest backup verifies: ${v.ok ? 'yes' : 'NO - ' + v.problems.join(' ')}`); const t = names.at(-1); if (names.length > 1 && names.at(-1) < names.at(-2)) L('  !! backups are out of time order: the server clock may have gone backwards'); }
  const bl = path.join(c.backupDir, 'backup.log'); if (fs.existsSync(bl)) { L('backup.log (last 10 lines):'); fs.readFileSync(bl, 'utf8').trim().split('\n').slice(-10).forEach(l => L('  ' + support.scrub(l))); }
});

H('Doctor');
{ const r = spawnSync(process.execPath, [path.join(__dirname, 'doctor.js')], { encoding: 'utf8', env: process.env, timeout: 30000 }); L(support.scrub((r.stdout || '') + (r.stderr || '')).trim()); }

H('Recent warnings and errors from the app log (last 60, secrets scrubbed)');
tryit('log', () => {
  const dir = process.env.LOG_DIR || path.join(path.dirname(c.dbPath), 'logs'), files = [path.join(dir, 'avl.log.1'), path.join(dir, 'avl.log')].filter(f => fs.existsSync(f));
  if (!files.length) { L(`no log file in ${dir} (older versions log to the console only: docker compose logs --tail 200 app / journalctl -u avl-hub -n 200)`); return; }
  const lines = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\n')).filter(l => / (WARN|ERROR|FATAL) /.test(l));
  L(`${lines.length} warning/error lines in the retained log; showing the last 60`); lines.slice(-60).forEach(l => L(support.scrub(l)));
});
if (db) db.close();

const text = out.join('\n') + '\n';
if (process.argv.includes('--stdout')) process.stdout.write(text);
else { const dir = path.join(path.dirname(c.dbPath), 'support'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const f = path.join(dir, `avl-support-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`); fs.writeFileSync(f, text, { mode: 0o600 });
  console.log(`Support bundle written to:\n  ${f}\nIt contains no passwords, keys or personal details. Send that file to the developer.\nDocker: docker compose exec -T app node scripts/support-bundle.js --stdout > support.txt`); }
