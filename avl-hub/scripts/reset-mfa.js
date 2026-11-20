'use strict';
// Emergency: someone lost their phone AND their recovery codes, and no administrator can reset them in the app.
//   node scripts/reset-mfa.js <username>        (server access only)
// Turns two-step sign-in off for that person and signs them out everywhere. They can enrol again (and must, if their role requires it).
const loadConfig = require('../server/config');
const { open, migrate } = require('../server/db');
const username = process.argv[2];
if (!username) { console.error('Usage: node scripts/reset-mfa.js <username>'); process.exit(2); }
const db = open(loadConfig().dbPath); migrate(db);
const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (!u) { console.error(`No account named "${username}".`); process.exit(1); }
const had = !!db.prepare('SELECT 1 FROM user_mfa WHERE user_id = ?').get(u.id);
db.transaction(() => {
  for (const t of ['user_mfa', 'mfa_recovery_codes', 'mfa_challenges']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  db.prepare('INSERT INTO audit_log (ts,actor_id,actor_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)').run(new Date().toISOString(), null, 'cli', 'mfa.reset_cli', 'user', u.id, JSON.stringify({ username: u.username, had_mfa: had }));
})();
console.log(had ? `Two-step sign-in is now off for "${u.username}".` : `"${u.username}" did not have two-step sign-in on. Nothing changed.`);
