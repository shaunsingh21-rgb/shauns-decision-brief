'use strict';
// Backup = a folder holding a consistent copy of the database + every uploaded file + manifest.json (checksums, counts).
// Uses SQLite's online backup, so it is safe while the app is running.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { migrate } = require('../../server/db');

const PREFIX = 'avl-backup-';
const NAME_RE = /^avl-backup-\d{8}-\d{6}$/;
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const knownMigrations = () => fs.readdirSync(path.join(__dirname, '..', '..', 'migrations')).filter(f => /^\d+_.+\.sql$/.test(f)).sort();

function inspectDb(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','schema_migrations')").all().map(r => r.name);
    if (!has.includes('users') || !has.includes('schema_migrations')) return { integrity, ok: false, reason: 'This does not look like an AVL Hub database.' };
    return { integrity, ok: integrity === 'ok', migrations: db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name),
      admins: db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n, users: db.prepare('SELECT COUNT(*) n FROM users').get().n };
  } finally { db.close(); }
}
function lockTree(dir) {
  fs.chmodSync(dir, 0o700);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) lockTree(p); else fs.chmodSync(p, 0o600); }
}
const countFiles = dir => { let n = 0, bytes = 0; if (fs.existsSync(dir)) for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile()) { n++; bytes += fs.statSync(path.join(dir, e.name)).size; } return { n, bytes }; };

async function createBackup({ dbPath, uploadDir, backupDir, keep = 14, now = new Date() }) {
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found at ${dbPath}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  // Folder names are timestamps. If one is taken (two backups in the same second), use the next free second rather than failing.
  let final = path.join(backupDir, PREFIX + stamp(now));
  for (let i = 0; fs.existsSync(final) && i < 120; i++) { now = new Date(now.getTime() + 1000); final = path.join(backupDir, PREFIX + stamp(now)); }
  if (fs.existsSync(final)) throw new Error('Could not choose a name for the backup folder.');
  const partial = final + '.partial';
  fs.rmSync(partial, { recursive: true, force: true }); fs.mkdirSync(partial, { mode: 0o700 });
  try {
    const src = new Database(dbPath, { fileMustExist: true });
    try { await src.backup(path.join(partial, 'avl-hub.db')); } finally { src.close(); }
    const info = inspectDb(path.join(partial, 'avl-hub.db'));
    if (!info.ok) throw new Error('The backup copy failed its integrity check: ' + (info.reason || info.integrity));
    const filesSrc = path.join(uploadDir, 'files');
    if (fs.existsSync(filesSrc)) fs.cpSync(filesSrc, path.join(partial, 'files'), { recursive: true });
    const fc = countFiles(path.join(partial, 'files'));
    const manifest = { format: 'avl-hub-backup', version: 1, created_at: now.toISOString(), db_sha256: sha256(path.join(partial, 'avl-hub.db')), db_bytes: fs.statSync(path.join(partial, 'avl-hub.db')).size,
      file_count: fc.n, files_bytes: fc.bytes, migrations: info.migrations, active_admins: info.admins, users: info.users };
    fs.writeFileSync(path.join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2));
    lockTree(partial);                                              // backups hold password hashes: readable by their owner only
    fs.renameSync(partial, final);                                 // only a complete backup ever gets the real name
    return { dir: final, manifest, pruned: prune(backupDir, keep) };
  } catch (e) { fs.rmSync(partial, { recursive: true, force: true }); throw e; }
}
// Deletes only folders that match our exact naming pattern, oldest first, keeping the newest `keep`.
function prune(backupDir, keep) {
  const dirs = fs.readdirSync(backupDir, { withFileTypes: true }).filter(e => e.isDirectory() && NAME_RE.test(e.name)).map(e => e.name).sort();
  const old = dirs.slice(0, Math.max(0, dirs.length - Math.max(1, keep)));
  for (const d of old) fs.rmSync(path.join(backupDir, d), { recursive: true, force: true });
  return old;
}
const listBackups = backupDir => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir, { withFileTypes: true }).filter(e => e.isDirectory() && NAME_RE.test(e.name)).map(e => e.name).sort() : []);

// Checks a backup folder WITHOUT changing anything. Returns {ok, problems[], manifest, info}.
function verifyBackup(dir) {
  const problems = [];
  const mf = path.join(dir, 'manifest.json'), dbf = path.join(dir, 'avl-hub.db');
  if (!fs.existsSync(mf) || !fs.existsSync(dbf)) return { ok: false, problems: ['This folder is not a complete AVL Hub backup (manifest.json or avl-hub.db is missing).'] };
  let manifest; try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return { ok: false, problems: ['manifest.json is damaged.'] }; }
  if (manifest.format !== 'avl-hub-backup' || manifest.version !== 1) problems.push('Unrecognised backup format.');
  if (sha256(dbf) !== manifest.db_sha256) problems.push('The database file does not match its checksum: the backup is damaged or was modified.');
  let info = null;
  if (!problems.length) {
    try { info = inspectDb(dbf); } catch (e) { problems.push('The database could not be opened: ' + e.message); }
    if (info && !info.ok) problems.push(info.reason || 'The database failed its integrity check: ' + info.integrity);
    if (info && info.ok) {
      const known = knownMigrations(), newer = info.migrations.filter(m => !known.includes(m));
      if (newer.length) problems.push(`This backup is from a NEWER version of AVL Hub (${newer.join(', ')}). Update the app first.`);
      if (info.admins < 1) problems.push('This backup has no active administrator account, so nobody could sign in after restoring it. Restore refused.');
    }
    const fc = countFiles(path.join(dir, 'files'));
    if (fc.n !== manifest.file_count) problems.push(`Expected ${manifest.file_count} uploaded files but found ${fc.n}.`);
  }
  return { ok: problems.length === 0, problems, manifest, info };
}

// Restores a verified backup. Never deletes current data: it is moved to before-restore-<time>/ next to the database first,
// and put back automatically if anything goes wrong. The app MUST be stopped.
function restoreBackup({ backupPath, dbPath, uploadDir, now = new Date() }) {
  const v = verifyBackup(backupPath);
  if (!v.ok) { const e = new Error(v.problems.join(' ')); e.problems = v.problems; throw e; }
  // The running app writes a heartbeat file every few seconds. If it is fresh, the app is live (even in another container): refuse.
  const beat = path.join(path.dirname(dbPath), '.avl-running');
  if (fs.existsSync(beat) && Date.now() - fs.statSync(beat).mtimeMs < 20000) throw new Error('The app appears to be running (it reported in a few seconds ago). Stop it first, wait a few seconds, then run the restore again.');
  if (fs.existsSync(dbPath)) {                                      // second check: refuse if something holds a write lock
    const probe = new Database(dbPath, { fileMustExist: true, timeout: 1500 });
    try { probe.exec('BEGIN EXCLUSIVE'); probe.exec('ROLLBACK'); } catch { throw new Error('The database is in use. Stop the app first, then run the restore again.'); } finally { probe.close(); }
  }
  const dataDir = path.dirname(dbPath), aside = path.join(dataDir, 'before-restore-' + stamp(now));
  const filesDir = path.join(uploadDir, 'files'), moved = [];
  const move = (from, to) => { if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); moved.push([from, to]); } };
  try {
    for (const suffix of ['', '-wal', '-shm']) move(dbPath + suffix, path.join(aside, path.basename(dbPath) + suffix));
    move(filesDir, path.join(aside, 'files'));
    fs.mkdirSync(path.dirname(dbPath), { recursive: true }); fs.copyFileSync(path.join(backupPath, 'avl-hub.db'), dbPath);
    fs.mkdirSync(uploadDir, { recursive: true });
    if (fs.existsSync(path.join(backupPath, 'files'))) fs.cpSync(path.join(backupPath, 'files'), filesDir, { recursive: true }); else fs.mkdirSync(filesDir, { recursive: true });
    const db = new Database(dbPath); try { migrate(db); } finally { db.close(); }         // bring an older backup up to the current schema
    const after = inspectDb(dbPath);
    if (!after.ok || after.admins < 1) throw new Error('The restored database did not pass the final check.');
    return { restored_from: backupPath, previous_data_kept_at: moved.length ? aside : null, manifest: v.manifest, admins: after.admins };
  } catch (e) {
    for (const [from, to] of moved.reverse()) { fs.rmSync(from, { recursive: true, force: true }); fs.renameSync(to, from); }   // put everything back
    throw e;
  }
}
const backupAgeHours = name => { const t = name.slice(PREFIX.length); return (Date.now() - Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15))) / 36e5; };
module.exports = { backupAgeHours, createBackup, verifyBackup, restoreBackup, listBackups, prune, inspectDb, NAME_RE };
