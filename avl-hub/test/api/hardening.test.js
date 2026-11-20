'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { harness, PW } = require('../helpers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const toClose = []; const mk = async o => { const h = await harness(o); toClose.push(h); return h; };
after(async () => { for (const h of toClose) await h.close(); });

test('per-user rate limits: password attempts, account management and uploads; other users are unaffected', async () => {
  const h = await mk({ ratePasswordPer15Min: 3, rateSensitivePerHour: 3, rateUploadsPerHour: 2 });
  const admin = await h.makeUser('admin'), tech = await h.makeUser('technician'), other = await h.makeUser('technician');
  const ac = await h.as(admin), kc = await h.as(tech), oc = await h.as(other);
  for (let i = 0; i < 3; i++) assert.equal((await kc.post('/api/auth/change-password', { current_password: 'wrong-current-pw', new_password: 'A-brand-new-passphrase' })).status, 403);
  const blocked = await kc.post('/api/auth/change-password', { current_password: PW, new_password: 'A-brand-new-passphrase' });
  assert.equal(blocked.status, 429); assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.equal((await oc.post('/api/auth/change-password', { current_password: 'wrong-current-pw', new_password: 'A-brand-new-passphrase' })).status, 403, 'a different user has their own allowance');
  for (let i = 0; i < 3; i++) assert.equal((await ac.post('/api/users', { username: `new.user${i}`, display_name: 'N', role: 'viewer' })).status, 201);
  assert.equal((await ac.post('/api/users', { username: 'new.user9', display_name: 'N', role: 'viewer' })).status, 429);
  assert.equal((await ac.get('/api/users')).status, 200, 'reading is not limited');
  for (let i = 0; i < 2; i++) assert.equal((await kc.upload({ purpose: 'photo' }, PNG, 'a.png')).status, 201);
  assert.equal((await kc.upload({ purpose: 'photo' }, PNG, 'a.png')).status, 429);
  assert.equal((await oc.upload({ purpose: 'photo' }, PNG, 'a.png')).status, 201);
});

test('the sign-in limiter caps attempts per device even across many usernames', async () => {
  const h = await mk({ loginIpMax: 5 }); const c = h.client();
  for (let i = 0; i < 5; i++) await c.login(`guess${i}`, 'bad-password-1234');
  const r = await c.login('guess-more', 'bad-password-1234'); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'RATE_LIMITED');
});

test('production mode: __Host- cookie that is Secure/HttpOnly/SameSite/path=/ with no Domain, HSTS, upgrade-insecure-requests', async () => {
  const h = await mk({ production: true, trustProxy: 1 });
  const u = await h.makeUser('admin'); const c = h.client(); const r = await c.login(u);
  const cookie = r.setCookie[0];
  assert.match(cookie, /^__Host-avl_sid=/); for (const a of [/; Secure/i, /; HttpOnly/i, /; SameSite=Lax/i, /; Path=\//i]) assert.match(cookie, a);
  assert.ok(!/domain=/i.test(cookie), '__Host- cookies must not set Domain');
  const res = await fetch(h.base + '/healthz');
  assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/); assert.match(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  const dev = await mk(); assert.equal((await fetch(dev.base + '/healthz')).headers.get('strict-transport-security'), null, 'no HSTS in dev, so localhost testing is not poisoned');
});

test('CSP kept strict: no inline script/style, no eval; the only relaxation is WebAssembly for the on-device OCR', async () => {
  const h = await mk(); const res = await fetch(h.base + '/'); const csp = res.headers.get('content-security-policy');
  const dir = n => (csp.split(';').map(s => s.trim()).find(s => s.startsWith(n + ' ')) || '');
  assert.equal(dir('script-src'), "script-src 'self' 'wasm-unsafe-eval'"); assert.equal(dir('style-src'), "style-src 'self'");
  assert.ok(!/unsafe-inline|unsafe-eval(?!')/.test(csp.replace("'wasm-unsafe-eval'", '')), 'no unsafe-inline / unsafe-eval');
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'", "connect-src 'self'"]) assert.ok(csp.includes(d), d);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff'); assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/); assert.match(res.headers.get('permissions-policy'), /microphone=\(\)/); assert.match(res.headers.get('permissions-policy'), /geolocation=\(\)/);
  assert.equal(res.headers.get('x-powered-by'), null);
  const api = await fetch(h.base + '/api/me'); assert.equal(api.headers.get('cache-control'), 'no-store', 'API responses are never cached');
});

test('secrets live only in environment variables: never in responses, the audit log, or the repository', async () => {
  const BRAVE = 'BSAtest-secret-brave-key-0123456789abcdef', ANTH = 'sk-ant-test-secret-anthropic-key-0123456789';
  const fake = async u => (String(u).includes('brave') ? { ok: true, json: async () => ({ web: { results: [] } }) } : { ok: true, json: async () => ({ content: [{ text: '{"summary":"x","unknown":[]}' }] }) });
  const h = await mk({ braveApiKey: BRAVE, anthropicApiKey: ANTH, fetchImpl: fake });
  const ac = await h.as(await h.makeUser('admin')); await ac.post('/api/sources', { domain: 'example-maker.com' });
  const seen = [];
  for (const p of ['/api/me', '/api/sources', '/api/users', '/api/audit?limit=200', '/api/admin/export']) seen.push(JSON.stringify((await ac.get(p)).body));
  seen.push(JSON.stringify((await ac.post('/api/research', { query: 'SAMPLE mixer' })).body), JSON.stringify((await ac.post('/api/ai/draft', { source_text: 'SAMPLE label text for a mixer' })).body));
  seen.push(JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()));
  for (const s of seen) { assert.ok(!s.includes(BRAVE) && !s.includes(ANTH), 'a key leaked into a response or the audit log'); }
  const html = await (await fetch(h.base + '/')).text(); assert.ok(!html.includes('sk-ant') && !html.includes('BSA'));

  // Repository scan: no real-looking keys or hard-coded credentials in anything that ships.
  const root = path.join(__dirname, '..', '..'), skip = new Set(['node_modules', 'data', 'backups', 'vendor', '.git', 'test']);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => skip.has(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(root).filter(f => !/\.(png|lock|json)$/.test(f) || /package\.json$/.test(f));
  const bad = [/sk-ant-[A-Za-z0-9_-]{10,}/, /BSA[A-Za-z0-9_-]{25,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(api[_-]?key|secret|token|passw(or)?d)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+]{16,}['"]/i];
  for (const f of files) { const s = fs.readFileSync(f, 'utf8'); for (const re of bad) assert.ok(!re.test(s), `${path.relative(root, f)} looks like it contains a secret (${re})`); }
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const g of ['.env', 'data/', 'backups/', 'node_modules/']) assert.ok(ignore.split('\n').includes(g), `.gitignore must list ${g}`);
  const ex = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const line of ex.split('\n').filter(l => /KEY|SECRET|PASSWORD|TOKEN/.test(l) && !l.startsWith('#'))) assert.match(line, /=\s*$/, `.env.example must not contain a value: ${line}`);
  const cfg = fs.readFileSync(path.join(root, 'server', 'config.js'), 'utf8'); assert.match(cfg, /env\.BRAVE_API_KEY/); assert.match(cfg, /env\.ANTHROPIC_API_KEY/);
});

test('housekeeping removes expired sessions, old replay records and stale lockout counters, and keeps current ones', async () => {
  const h = await mk(); const u = await h.makeUser('technician'); const day = 864e5, iso = ms => new Date(Date.now() + ms).toISOString();
  const ins = (id, exp) => h.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,NULL)').run(id, u.id, iso(-day), iso(-day), exp);
  ins('expired-session-hash', iso(-1000)); ins('live-session-hash', iso(+day));
  const idem = (k, at) => h.db.prepare('INSERT INTO idempotency VALUES (?,?,?,?,?,?,?)').run(u.id, k, 'POST', '/api/x', 200, '{}', at);
  idem('old-key-aaaaaaaaaaaaaaaa', iso(-40 * day)); idem('new-key-bbbbbbbbbbbbbbbb', iso(-1 * day));
  const lf = (k, locked, upd) => h.db.prepare('INSERT INTO login_failures VALUES (?,?,?,?)').run(k, 2, locked, upd);
  lf('stale', null, iso(-3 * day)); lf('recent', null, iso(-1000)); lf('lockedstill', iso(+day), iso(-3 * day));
  h.ctx.maintain();
  const has = (sql, v) => !!h.db.prepare(sql).get(v);
  assert.ok(!has('SELECT 1 FROM sessions WHERE id_hash=?', 'expired-session-hash')); assert.ok(has('SELECT 1 FROM sessions WHERE id_hash=?', 'live-session-hash'));
  assert.ok(!has('SELECT 1 FROM idempotency WHERE key=?', 'old-key-aaaaaaaaaaaaaaaa')); assert.ok(has('SELECT 1 FROM idempotency WHERE key=?', 'new-key-bbbbbbbbbbbbbbbb'));
  assert.ok(!has('SELECT 1 FROM login_failures WHERE key=?', 'stale')); assert.ok(has('SELECT 1 FROM login_failures WHERE key=?', 'recent')); assert.ok(has('SELECT 1 FROM login_failures WHERE key=?', 'lockedstill'), 'an active lock is never cleaned early');
});

test('error responses never leak internals; oversized bodies are refused; wrong content types do nothing', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin'));
  const big = await ac.post('/api/issues', { kind: 'issue', title: 'x', body: 'y'.repeat(300 * 1024) }); assert.equal(big.status, 413);
  const res = await fetch(h.base + '/api/sources', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-requested-by': 'avl-hub', cookie: ac.cookie }, body: '{"domain":"example.com"}' });
  assert.equal(res.status, 400, 'a non-JSON body is not parsed');
  const err = JSON.stringify((await ac.get('/api/equipment/not-a-uuid')).body); assert.ok(!/at .*\.js|node_modules|SQLITE|stack/i.test(err));
});
