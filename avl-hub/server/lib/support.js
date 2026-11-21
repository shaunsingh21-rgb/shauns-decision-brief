'use strict';
// Supportability helpers: what version is running, is it REALLY healthy, plain-language explanations of common failures,
// a small rotating log file, and .env checks. Nothing here prints secrets.
const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');
const knownMigrations = () => fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => /^\d+_.+\.sql$/.test(f)).sort();

// ---- version -------------------------------------------------------------------------------------------------------
// The commit comes from (1) a BUILD_INFO json file written at image build time, (2) AVL_COMMIT, (3) git if the .git folder is there.
let _build;
function buildInfo() {
  if (_build) return _build;
  let commit = process.env.AVL_COMMIT || null, built = process.env.AVL_BUILT_AT || null;
  try { const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'BUILD_INFO'), 'utf8')); commit = commit || b.commit; built = built || b.built_at; } catch { /* no file */ }
  if (!commit) { try { commit = require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim(); } catch { /* not a git checkout */ } }
  return (_build = { name: pkg.name, version: pkg.version, commit: commit || 'unknown', built_at: built || null, node: process.versions.node });
}
function schemaInfo(db) {
  const known = knownMigrations();
  const applied = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name);
  return { latest_known: known.at(-1), latest_applied: applied.at(-1) || null, applied: applied.length, known: known.length,
    newer_than_this_app: applied.filter(m => !known.includes(m)), pending: known.filter(m => !applied.includes(m)) };
}

// ---- deep health ---------------------------------------------------------------------------------------------------
// Hard failures (status 'failing', HTTP 503) are things that mean the app cannot do its job right now.
// Warnings (status 'degraded', HTTP 200) mean "fix soon" and must NOT make Docker kill a working server.
function makeHealth(ctx) {
  const { db, config } = ctx; let startIno = null; try { startIno = fs.statSync(config.dbPath).ino; } catch { /* :memory: */ }
  let cache = { at: 0, v: null };
  const uploadsProbe = () => { const p = path.join(config.uploadDir, '_tmp', '.health-' + process.pid); fs.writeFileSync(p, 'x'); fs.rmSync(p); };
  return function health() {
    if (Date.now() - cache.at < 5000) return cache.v;          // a 30-second Docker probe plus a person refreshing must not hammer the disk
    const problems = [], warnings = [], checks = {};
    try { db.prepare('SELECT 1').get(); const n = db.prepare('SELECT COUNT(*) n FROM users').get().n; checks.database = true; if (!n) warnings.push('There are no accounts yet.'); }
    catch (e) { checks.database = false; problems.push('The database cannot be read: ' + explainError(e).short); }
    if (checks.database) {
      try { const s = schemaInfo(db); checks.schema = !s.newer_than_this_app.length && !s.pending.length;
        if (s.newer_than_this_app.length) problems.push('The database is from a NEWER version of the app than the one running.');
        if (s.pending.length) problems.push('The database has not been brought up to date (' + s.pending.join(', ') + ').'); } catch (e) { checks.schema = false; problems.push('Schema check failed.'); }
    }
    if (config.dbPath !== ':memory:') {
      try { const ino = fs.statSync(config.dbPath).ino; checks.database_file = ino === startIno;
        if (ino !== startIno) problems.push('The database file was replaced or restored while the app was running. Restart the app (changes made since may be lost).'); }
      catch { checks.database_file = false; problems.push('The database file has disappeared from disk while the app is running. Do NOT keep using the app: restore a backup.'); }
    }
    try { uploadsProbe(); checks.uploads_writable = true; } catch (e) { checks.uploads_writable = false; problems.push('The uploads folder cannot be written (' + explainError(e).short + ').'); }
    try { const s = fs.statfsSync(path.dirname(config.dbPath)); const gb = s.bavail * s.bsize / 1e9; checks.disk_free_gb = Math.round(gb * 10) / 10;
      if (gb < 0.1) problems.push('The data disk is almost completely full.'); else if (gb < 2) warnings.push(`Only ${gb.toFixed(1)} GB free on the data disk.`); } catch { /* not available */ }
    try { const { listBackups, backupAgeHours } = require('../../scripts/lib/backup'); const names = listBackups(config.backupDir);
      checks.newest_backup_hours = names.length ? Math.round(backupAgeHours(names.at(-1))) : null;
      if (!names.length) warnings.push('No backup exists yet.'); else if (backupAgeHours(names.at(-1)) > 36) warnings.push(`The newest backup is ${Math.round(backupAgeHours(names.at(-1)))} hours old: nightly backups may have stopped.`); } catch { /* backup folder unreadable: not our business here */ }
    const v = { ok: !problems.length, status: problems.length ? 'failing' : warnings.length ? 'degraded' : 'ok', problems, warnings, checks };
    cache = { at: Date.now(), v }; return v;
  };
}

// ---- plain-language explanations of the errors an administrator is most likely to meet ----------------------------------
function explainError(e) {
  const code = e && (e.code || ''), msg = (e && e.message) || String(e);
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') return { short: 'the disk is full', fix: 'Free some disk space (delete old before-restore-… folders, lower BACKUP_KEEP, or ask IT for more disk), then restart the app.' };
  if (/readonly database|SQLITE_READONLY/i.test(msg) || code === 'EACCES' || code === 'EPERM' || code === 'SQLITE_CANTOPEN')
    return { short: 'the app is not allowed to write there (file permissions)', fix: 'The account that runs the app must own the data folder and the database file. Docker: the /data volume must be owned by user 10001. systemd: sudo chown -R avl:avl <data folder>.' };
  if (code === 'EADDRINUSE') return { short: 'that port is already in use', fix: 'Another program, or a second copy of this app, is already using the port. Stop it, or change PORT in .env.' };
  if (code === 'ENOENT') return { short: 'a file or folder that should exist is missing', fix: 'If the uploads or data folder was deleted, restore the newest backup (docs/BACKUP.md).' };
  if (/MFA_ENCRYPTION_KEY/.test(msg)) return { short: 'MFA_ENCRYPTION_KEY in .env is not valid', fix: 'It must be exactly 64 hex characters. Make one with: openssl rand -hex 32. If you had one before, put the OLD key back.' };
  if (/NEWER version/.test(msg)) return { short: 'the database is newer than this copy of the app', fix: 'Do not run older code on this data. Update the app to the newer version, or restore a backup made by this version.' };
  return { short: msg.split('\n')[0].slice(0, 160), fix: null };
}

// ---- small rotating log file (so there is always something to send the developer, on Docker or systemd) -----------------
function makeLogger(dir, { maxBytes = 2 * 1048576, keep = 5, quiet = false } = {}) {
  let file = null; try { fs.mkdirSync(dir, { recursive: true }); file = path.join(dir, 'avl.log'); fs.accessSync(dir, fs.constants.W_OK); } catch { file = null; }
  const rotate = () => { try { if (fs.statSync(file).size < maxBytes) return; for (let i = keep - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); fs.renameSync(file, file + '.1'); } catch { /* first write */ } };
  const write = (level, parts, fileOnly) => {
    const line = `${new Date().toISOString()} ${level} ${parts.map(p => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
    if (!(level === 'INFO' && quiet) && !(fileOnly && file)) (level === 'ERROR' || level === 'FATAL' || level === 'WARN' ? console.error : console.log)(line);   // quiet: in-process test servers only
    if (file) { try { rotate(); fs.appendFileSync(file, line + '\n', { mode: 0o600 }); } catch { /* never let logging break the app */ } }
  };
  return { info: (...a) => write('INFO', a), warn: (...a) => write('WARN', a), error: (...a) => write('ERROR', a), fatal: (...a) => write('FATAL', a), detail: (...a) => write('DETAIL', a, true), file: () => file };
}

// ---- .env checks: the mistakes that currently fail silently ----------------------------------------------------------
const KNOWN_KEYS = ['NODE_ENV', 'PORT', 'TRUST_PROXY', 'DB_PATH', 'UPLOAD_DIR', 'BACKUP_DIR', 'BACKUP_KEEP', 'BACKUP_COPY_TO', 'OFFSITE_DIR', 'SHAREPOINT_HOSTS', 'MFA_ENCRYPTION_KEY',
  'BRAVE_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'MAX_PHOTO_MB', 'MAX_DOC_MB', 'MAX_VIDEO_MB', 'SESSION_TTL_HOURS', 'SESSION_MAX_DAYS', 'LOCKOUT_MAX_FAILURES', 'LOCKOUT_MINUTES',
  'LOCKOUT_GLOBAL_FAILURES', 'QUIZ_ATTEMPTS_PER_HOUR', 'LOGIN_IP_MAX', 'API_RATE_MAX', 'MIN_PASSWORD_LENGTH', 'AUTH_PROVIDER', 'AI_RATE_PER_HOUR', 'RATE_UPLOADS_PER_HOUR', 'RATE_SENSITIVE_PER_HOUR',
  'RATE_PASSWORD_PER_15MIN', 'DOMAIN', 'ENV_FILE', 'AVL_NO_ENV_FILE', 'AVL_COMMIT', 'AVL_BUILT_AT', 'LOG_DIR', 'AVL_ALLOW_NEWER_SCHEMA'];
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
function lintEnvText(txt) {
  const out = [];
  if (txt.charCodeAt(0) === 0xFEFF) out.push({ line: 1, msg: 'The file starts with a hidden byte-order mark (saved by Notepad?). The first setting may be ignored.' });
  if (/\r\n/.test(txt)) out.push({ line: 0, msg: 'The file has Windows line endings (CRLF). This app copes, but `sh`-based tools (the backup script) may not. Re-save with Unix line endings.' });
  txt.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1, t = line.trim(); if (!t || t.startsWith('#')) return;
    const m = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) { out.push({ line: n, msg: `Not a KEY=value line, so it is ignored: "${t.slice(0, 30)}${t.length > 30 ? '…' : ''}"` }); return; }
    const [, exp, key, val] = m;
    if (exp) out.push({ line: n, msg: `"export" is not understood by this app's settings file; the line ${key} is IGNORED unless your service manager reads it. Remove the word "export".` });
    if (!KNOWN_KEYS.includes(key)) { const near = KNOWN_KEYS.map(k => [k, lev(key, k)]).sort((a, b) => a[1] - b[1])[0]; out.push({ line: n, msg: `Unknown setting ${key}, so it does nothing.` + (near[1] <= 3 ? ` Did you mean ${near[0]}?` : '') }); }
    if (/^[^'"].*\s#/.test(val)) out.push({ line: n, msg: `${key} has a "#" comment on the same line. Put comments on their own line.` });
    if (/^(['"]).*[^'"]$|^[^'"].*['"]$/.test(val) && !/^(['"]).*\1$/.test(val)) out.push({ line: n, msg: `${key} has an unmatched quote.` });
    if (key === 'NODE_ENV' && val.replace(/^['"]|['"]$/g, '') !== 'production' && /production/i.test(val)) out.push({ line: n, msg: 'NODE_ENV must be exactly "production" (lower case). Anything else runs in test mode with insecure cookies.' });
    if (key === 'SHAREPOINT_HOSTS' && /:\/\/|\//.test(val)) out.push({ line: n, msg: 'SHAREPOINT_HOSTS must be host names only (yourorg.sharepoint.com), without https:// or a path.' });
    if (key === 'MFA_ENCRYPTION_KEY' && val && !/^['"]?[0-9a-fA-F]{64}['"]?$/.test(val)) out.push({ line: n, msg: 'MFA_ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32).' });
    if (key === 'TRUST_PROXY' && val && !/^\d+$/.test(val)) out.push({ line: n, msg: 'TRUST_PROXY should be the number 1 behind Caddy/nginx.' });
    if (/^(PORT|MAX_.*_MB|SESSION_.*|LOCKOUT_.*|BACKUP_KEEP)$/.test(key) && val && !/^\d+$/.test(val.replace(/^['"]|['"]$/g, ''))) out.push({ line: n, msg: `${key} should be a whole number.` });
  });
  return out;
}
// Remove anything that looks like a secret from text that may be sent to the developer.
const scrub = s => String(s).replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted-hex]').replace(/(authorization|cookie|password|secret|token|api[_-]?key)(["':= ]+)[^\s"',;]+/gi, '$1$2[redacted]')
  .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[redacted-key]');

module.exports = { buildInfo, schemaInfo, makeHealth, explainError, makeLogger, lintEnvText, scrub, knownMigrations, KNOWN_KEYS };
