'use strict';
// Restore:  node scripts/restore.js <backup-folder> [--yes]      STOP THE APP FIRST.
// Checks the backup, moves the current data aside (never deletes it), restores, and re-checks. Refuses a backup with no admin.
const readline = require('readline'), path = require('path');
const loadConfig = require('../server/config');
const { restoreBackup, verifyBackup, listBackups } = require('./lib/backup');
(async () => {
  const c = loadConfig(), args = process.argv.slice(2), yes = args.includes('--yes'), target = args.find(a => !a.startsWith('--'));
  if (!target) { console.error(`Usage: node scripts/restore.js <backup-folder> [--yes]\nBackups in ${c.backupDir}:\n  ${listBackups(c.backupDir).join('\n  ') || '(none)'}`); process.exit(2); }
  const dir = path.resolve(target), v = verifyBackup(dir);
  if (!v.ok) { console.error('Cannot restore:\n - ' + v.problems.join('\n - ')); process.exit(1); }
  console.log(`Backup made ${v.manifest.created_at}: ${v.manifest.users} accounts (${v.manifest.active_admins} admin), ${v.manifest.file_count} uploaded files.\nThis REPLACES the current data in ${c.dbPath} and ${c.uploadDir}. The current data is kept in a before-restore-… folder.`);
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise(r => rl.question('Type RESTORE to continue: ', r)); rl.close();
    if (a.trim() !== 'RESTORE') { console.log('Cancelled. Nothing was changed.'); process.exit(1); }
  }
  try { const r = restoreBackup({ backupPath: dir, dbPath: c.dbPath, uploadDir: c.uploadDir }); console.log(`Restored. Previous data kept at: ${r.previous_data_kept_at || '(there was none)'}\nNow start the app again.`); }
  catch (e) { console.error('RESTORE FAILED (your existing data was put back): ' + e.message); process.exit(1); }
})();
