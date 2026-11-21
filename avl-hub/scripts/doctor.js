'use strict';
// Plain-language health check:  npm run doctor      (never prints secrets)
const fs = require('fs'), path = require('path');
const loadConfig = require('../server/config');
const { open, migrate } = require('../server/db');
const { listBackups } = require('./lib/backup');
const { keyBuf } = require('../server/lib/totp');
const c = loadConfig(); let bad = 0;
const say = (lvl, msg) => { if (lvl === 'x') bad++; console.log(`${{ ok: '✔', warn: '⚠', x: '✖' }[lvl === 'x' ? 'x' : lvl]} ${msg}`); };
{ const support = require('../server/lib/support'), envFile = process.env.ENV_FILE || path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) { const probs = support.lintEnvText(fs.readFileSync(envFile, 'utf8')); probs.length ? probs.forEach(p => say('warn', `.env line ${p.line}: ${p.msg}`)) : say('ok', '.env file has no obvious typos');
    if (fs.statSync(envFile).mode & 0o077) say('warn', `.env is readable by other users on this server (it holds keys). Run:  chmod 600 ${envFile}`); }
  const b = support.buildInfo(); say('ok', `AVL Hub ${b.version} (commit ${b.commit})`); }
const major = parseInt(process.versions.node, 10);
major >= 20 ? say('ok', `Node ${process.versions.node}`) : say('x', `Node ${process.versions.node} is too old; version 20 or newer is required.`);
say(c.production ? 'ok' : 'warn', c.production ? 'Running in production mode' : 'NODE_ENV is not "production" (cookies are not marked Secure). Fine for testing, not for the real server.');
if (c.production) say(c.trustProxy ? 'ok' : 'warn', c.trustProxy ? 'TRUST_PROXY is set' : 'TRUST_PROXY is not set. Behind Caddy/nginx set TRUST_PROXY=1.');
try {
  fs.mkdirSync(path.dirname(c.dbPath), { recursive: true }); fs.accessSync(path.dirname(c.dbPath), fs.constants.W_OK); say('ok', `Data folder is writable (${path.dirname(c.dbPath)})`);
  const db = open(c.dbPath); const applied = migrate(db); if (applied.length) say('ok', `Database updated: ${applied.join(', ')}`);
  say(db.pragma('quick_check', { simple: true }) === 'ok' ? 'ok' : 'x', 'Database integrity check');
  const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n;
  admins ? say('ok', `${admins} active administrator account(s)`) : say('x', 'No administrator exists yet. Run:  npm run create-admin -- <username> "<Your Name>"');
  const enrolled = db.prepare('SELECT COUNT(*) n FROM user_mfa WHERE enabled_at IS NOT NULL').get().n, requiring = db.prepare('SELECT COUNT(*) n FROM roles WHERE require_mfa=1').get().n;
  let keyOk = false; if (c.mfaEncryptionKey) { try { keyBuf(c.mfaEncryptionKey); keyOk = true; } catch (e) { say('x', 'MFA_ENCRYPTION_KEY is set but invalid: ' + e.message); } }
  if (keyOk) say('ok', `Two-step sign-in is available (${enrolled} ${enrolled === 1 ? 'person has' : 'people have'} it on; ${requiring} role(s) require it)`);
  else if (!c.mfaEncryptionKey) say(enrolled || requiring ? 'x' : 'warn', enrolled || requiring ? `Two-step sign-in is in use (${enrolled} people, ${requiring} roles) but MFA_ENCRYPTION_KEY is not set: those people CANNOT sign in until the key is restored.` : 'Two-step sign-in is off (optional). To offer it, set MFA_ENCRYPTION_KEY (see .env.example).');
  const sources = db.prepare('SELECT COUNT(*) n FROM source_domains').get().n;
  say(sources ? 'ok' : 'warn', sources ? `${sources} official source domain(s) listed` : 'No official source domains yet (Admin → Official source domains). Web research stays off until you add some.');
  db.close();
} catch (e) { say('x', 'Database problem: ' + e.message); }
say(c.braveApiKey ? 'ok' : 'warn', c.braveApiKey ? 'Web search key is set' : 'No BRAVE_API_KEY: web search in the Add Equipment wizard is off (optional).');
say(c.anthropicApiKey ? 'ok' : 'warn', c.anthropicApiKey ? 'AI drafting key is set' : 'No ANTHROPIC_API_KEY: AI drafting is off (optional).');
say(c.sharepointHosts.length ? 'ok' : 'warn', c.sharepointHosts.length ? `SharePoint embeds limited to ${c.sharepointHosts.join(', ')}` : 'SHAREPOINT_HOSTS is not set: any *.sharepoint.com embed is allowed. Setting it to your own tenant is safer.');
const bks = listBackups(c.backupDir);
if (!bks.length) say('warn', `No backups found in ${c.backupDir}. Run:  npm run backup   and schedule it nightly.`);
else { const t = bks.at(-1).slice(11), when = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15)); const hrs = (Date.now() - when) / 36e5;
  say(hrs < 36 ? 'ok' : 'warn', `Newest backup is ${hrs < 1 ? 'under an hour' : Math.round(hrs) + ' hours'} old (${bks.length} kept)${hrs < 36 ? '' : ' — nightly backups may have stopped'}`); }
try { const s = fs.statfsSync(path.dirname(c.dbPath)); const gb = s.bavail * s.bsize / 1e9; say(gb > 2 ? 'ok' : 'warn', `${gb.toFixed(1)} GB free on the data disk`); } catch { /* not available */ }
console.log(bad ? `\n${bad} problem(s) need fixing.` : '\nNo blocking problems found.'); process.exit(bad ? 1 : 0);
