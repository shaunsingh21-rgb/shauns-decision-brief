'use strict';
// One-time first-run admin. Refuses if any admin already exists. There is NO default password anywhere.
//   npm run create-admin -- <username> "<Display Name>"
// The password is read from a hidden prompt, or from AVL_ADMIN_PASSWORD for non-interactive setup.
const crypto = require('crypto');
const readline = require('readline');
const loadConfig = require('../server/config');
const { open, migrate } = require('../server/db');
const argon2 = require('argon2');
const { checkPasswordPolicy } = require('../server/routes/auth');

function askHidden(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}
(async () => {
  const [username, ...rest] = process.argv.slice(2);
  const display = rest.join(' ') || username;
  if (!username || !/^[A-Za-z0-9._@-]{3,64}$/.test(username)) { console.error('Usage: npm run create-admin -- <username> "<Display Name>"'); process.exit(2); }
  const config = loadConfig();
  const db = open(config.dbPath); migrate(db);
  if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) { console.error('An administrator already exists. Use the app (Users) to create more accounts.'); process.exit(1); }
  let pw = process.env.AVL_ADMIN_PASSWORD;
  if (!pw) {
    pw = await askHidden('New admin password: ');
    if (pw !== await askHidden('Repeat password: ')) { console.error('Passwords did not match.'); process.exit(1); }
  }
  try { checkPasswordPolicy(config, pw, username); } catch (e) { console.error(e.message); process.exit(1); }
  const hashed = await argon2.hash(pw, { type: argon2.argon2id });
  const id = crypto.randomUUID(), now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,must_change_password,auth_provider,created_at,updated_at)
                VALUES (?,?,?,'admin',?,1,'local',?,?)`).run(id, username, display, hashed, now, now);
    db.prepare('INSERT INTO audit_log (ts,actor_id,actor_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)')
      .run(now, null, 'cli', 'user.create_first_admin', 'user', id, JSON.stringify({ username }));
  })();
  console.log(`Admin "${username}" created. You will be asked to change this password at first sign-in.`);
})();
