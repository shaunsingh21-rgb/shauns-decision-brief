'use strict';
// Emergency recovery when NO administrator can sign in:   node scripts/reset-password.js <username>
// Run on the server only. Sets a new temporary password (asked for with hidden typing, or AVL_NEW_PASSWORD), forces a change at next sign-in,
// clears any lockout, signs the person out everywhere, re-enables the account, and records it in the audit log.
const readline = require('readline');
const argon2 = require('argon2');
const loadConfig = require('../server/config');
const { open, migrate } = require('../server/db');
const { checkPasswordPolicy } = require('../server/routes/auth');

function askHidden(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}
(async () => {
  const username = process.argv[2];
  if (!username) { console.error('Usage: node scripts/reset-password.js <username>'); process.exit(2); }
  const config = loadConfig(), db = open(config.dbPath); migrate(db);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) { console.error(`No account named "${username}".`); process.exit(1); }
  if (user.auth_provider !== 'local') { console.error('That account signs in with single sign-on and has no local password.'); process.exit(1); }
  let pw = process.env.AVL_NEW_PASSWORD;
  if (!pw) { pw = await askHidden('New temporary password: '); if (pw !== await askHidden('Repeat password: ')) { console.error('Passwords did not match.'); process.exit(1); } }
  try { checkPasswordPolicy(config, pw, user.username); } catch (e) { console.error(e.message); process.exit(1); }
  const hash = await argon2.hash(pw, { type: argon2.argon2id }), now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=?, must_change_password=1, disabled=0, updated_at=? WHERE id=?').run(hash, now, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM login_failures WHERE key=?').run(user.username.toLowerCase());
    db.prepare('INSERT INTO audit_log (ts,actor_id,actor_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)')
      .run(now, null, 'cli', 'user.reset_password_cli', 'user', user.id, JSON.stringify({ username: user.username, was_disabled: !!user.disabled }));
  })();
  console.log(`Done. "${user.username}" can sign in with the new temporary password and will be asked to choose their own.`);
})();
