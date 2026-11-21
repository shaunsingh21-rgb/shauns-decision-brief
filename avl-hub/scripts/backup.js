'use strict';
// Nightly backup:  node scripts/backup.js        (env: DB_PATH, UPLOAD_DIR, BACKUP_DIR, BACKUP_KEEP, BACKUP_COPY_TO)
// Exit code 0 = good backup made. Non-zero = FAILED (cron/systemd will flag it). BACKUP_COPY_TO is an optional second location.
const fs = require('fs'), path = require('path');
const loadConfig = require('../server/config');
const { createBackup, verifyBackup } = require('./lib/backup');
(async () => {
  const c = loadConfig(), keep = parseInt(process.env.BACKUP_KEEP || '14', 10);
  try {
    const r = await createBackup({ dbPath: c.dbPath, uploadDir: c.uploadDir, backupDir: c.backupDir, keep });
    const v = verifyBackup(r.dir); if (!v.ok) throw new Error('Verification failed: ' + v.problems.join(' '));
    console.log(`OK  ${r.dir}  (${(r.manifest.db_bytes / 1024).toFixed(0)} KB database, ${r.manifest.file_count} uploaded files, ${r.manifest.active_admins} admin(s))` + (r.pruned.length ? `  — removed ${r.pruned.length} old backup(s)` : ''));
    if (r.clockBehind) { console.error(`WARNING: the server clock looks WRONG. This backup is dated earlier than an existing one (${r.newestOther}). Nothing was deleted. Fix the server date/time (timedatectl), then check the backups list.`); process.exitCode = 4; }
    const copy = process.env.BACKUP_COPY_TO;
    if (copy) {
      try { fs.mkdirSync(copy, { recursive: true }); fs.cpSync(r.dir, path.join(copy, path.basename(r.dir)), { recursive: true }); console.log(`OK  copied to ${copy}`); }
      catch (e) { console.error(`WARNING: the backup was made, but copying it to ${copy} failed: ${e.message}`); process.exit(3); }
    }
  } catch (e) { console.error('BACKUP FAILED: ' + e.message); process.exit(1); }
})();
