'use strict';
// Round-2 review findings, each reproduced by the red team and proven fixed here.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { harness, PW } = require('../helpers');

const closers = []; const mk = async o => { const h = await harness({ trustProxy: 1, mfaEncryptionKey: 'ab12'.repeat(16), ...o }); closers.push(h); return h; };
after(async () => { for (const h of closers) await h.close(); });
const from = (h, ip) => { const c = h.client(); const req = c.req.bind(c); c.req = (m, p, b, o = {}) => req(m, p, b, { ...o, headers: { ...(o.headers || {}), 'x-forwarded-for': ip } }); c.post = (p, b = {}) => c.req('POST', p, b); c.get = p => c.req('GET', p); return c; };
const login = (c, u, pw) => c.post('/api/auth/login', { username: u, password: pw });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('honest typos never add up: 25 rounds of "one wrong, then right" never lock the account', async () => {
  const h = await mk({ lockoutMaxFailures: 6, lockoutGlobalFailures: 20 }); await h.makeUser('admin', 'typist'); const c = from(h, '10.2.2.2');
  for (let i = 0; i < 25; i++) { await login(c, 'typist', 'wrong-password-12'); assert.equal((await login(c, 'typist', PW)).status, 200, `round ${i + 1}`); }
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM login_failures").get().n, 0);
});

test('idle failures fade: an unlocked counter untouched for a lock period starts again', async () => {
  const h = await mk({ lockoutMaxFailures: 6, lockoutGlobalFailures: 20, lockoutMinutes: 15 }); await h.makeUser('technician', 'fader'); const c = from(h, '10.2.2.3');
  for (let i = 0; i < 4; i++) await login(c, 'fader', 'wrong-password-12');
  const old = new Date(Date.now() - 16 * 60000).toISOString(); h.db.prepare('UPDATE login_failures SET updated_at=?').run(old);
  for (let i = 0; i < 5; i++) assert.equal((await login(c, 'fader', 'wrong-password-12')).status, 401, 'fresh allowance after the fade');
});

test('one noisy address cannot lock an account for everyone: attempts it makes after its own lock do not count toward the all-address ceiling', async () => {
  const h = await mk({ lockoutMaxFailures: 5, lockoutGlobalFailures: 20 }); await h.makeUser('admin', 'bossman');
  for (let a = 0; a < 3; a++) for (let i = 0; i < 40; i++) await login(from(h, `203.0.113.${a + 1}`), 'bossman', 'wrong-password-12');
  assert.equal((await login(from(h, '198.51.100.7'), 'bossman', PW)).status, 200, 'the real person is let in from their own address');
});

test('an IPv6 attacker rotating inside one /64 stays on one counter', async () => {
  const h = await mk({ lockoutMaxFailures: 5, lockoutGlobalFailures: 50 }); await h.makeUser('technician', 'sixer');
  for (let i = 0; i < 8; i++) await login(from(h, `2001:db8:1:2:${i}::1`), 'sixer', 'wrong-password-12');
  assert.equal((await login(from(h, '2001:db8:1:2:ffff::9'), 'sixer', PW)).status, 429, 'the whole /64 is locked');
  assert.equal((await login(from(h, '2001:db8:9:9::1'), 'sixer', PW)).status, 200, 'a different network is not');
});

test('credentials are not kept for replay however the URL is capitalised', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin')); const key = () => 'op-' + crypto.randomUUID();
  for (const p of ['/API/users', '/Api/Users', '/api/USERS']) {
    const r = await ac.req('POST', p, { username: 'case' + crypto.randomBytes(3).toString('hex'), display_name: 'C', role: 'viewer' }, { headers: { 'idempotency-key': key() } });
    assert.equal(r.status, 201, p); assert.ok(r.body.temporary_password);
  }
  const m = await ac.req('POST', '/API/Auth/mfa/setup', {}, { headers: { 'idempotency-key': key() } });
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM idempotency WHERE body LIKE '%temporary_password%' OR body LIKE '%otpauth%' OR lower(path) LIKE '/api/users%' OR lower(path) LIKE '/api/auth%'").get().n, 0, 'nothing credential-bearing stored (setup status ' + m.status + ')');
});

test('an upload ?purpose= that names a built-in object property is a clean 400, not a hang or a 500', async () => {
  const h = await mk(); const c = await h.as(await h.makeUser('admin'));
  for (const purpose of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = await Promise.race([c.upload({ purpose }, PNG, 'x.png'), new Promise(res => setTimeout(() => res({ status: 'HUNG' }), 4000))]);
    assert.equal(r.status, 400, purpose);
  }
});

test('the audit log never keeps a typed name that is not an account (often a password), and hides training detail from people who cannot view progress', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin')); await login(h.client(), PW, 'whatever-123456');
  const rows = (await ac.get('/api/audit?limit=100')).body.entries; assert.ok(rows.some(e => e.action.startsWith('auth.')), 'the failure is still recorded');
  assert.ok(!JSON.stringify(rows).includes(PW), 'but the typed text is not');
  const role = (await ac.post('/api/roles', { name: 'Auditor Only', permissions: ['audit.view'] })).body.role; const au = await h.as(await h.makeUser(role.id));
  const trainer = await h.as(await h.makeUser('trainer')); const tech = await h.makeUser('technician');
  const m = (await trainer.post('/api/modules', { title: 'Audit module', level: 1, summary: 's' })).body.module;
  h.db.prepare("INSERT INTO audit_log (ts,actor_id,actor_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)").run(new Date().toISOString(), null, 'T', 'signoff.create', 'module', m.id, JSON.stringify({ trainee: 'X', note: 'PRIVATE-NOTE', quiz_pct: 90, scores: [2, 3] }));
  const mine = JSON.stringify((await au.get('/api/audit?limit=100')).body.entries); assert.ok(!mine.includes('PRIVATE-NOTE') && !mine.includes('quiz_pct'), 'hidden for audit-only');
  assert.ok(JSON.stringify((await ac.get('/api/audit?limit=100')).body.entries).includes('PRIVATE-NOTE'), 'the administrator still sees it'); void tech;
});

test('an equal-power role cannot be used to move someone out of a two-step-required role', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin'));
  const strict = (await ac.post('/api/roles', { name: 'Strict', permissions: ['equipment.edit'], require_mfa: true })).body.role;
  const lax = (await ac.post('/api/roles', { name: 'Lax', permissions: ['equipment.edit'] })).body.role;
  const mgr = (await ac.post('/api/roles', { name: 'People Manager', permissions: ['users.manage', 'roles.manage', 'data.manage', 'equipment.edit'] })).body.role;
  const m = await h.as(await h.makeUser(mgr.id)); const victim = await h.makeUser(strict.id, 'strictone');
  const r = await m.patch(`/api/users/${victim.id}`, { role: lax.id }); assert.equal(r.status, 403);
  assert.equal((await ac.patch(`/api/users/${victim.id}`, { role: lax.id })).status, 200, 'a Leader/Admin still can');
});
