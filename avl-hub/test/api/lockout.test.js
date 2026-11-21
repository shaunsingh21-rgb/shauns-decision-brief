'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness, PW } = require('../helpers');

const closers = []; const mk = async o => { const h = await harness({ trustProxy: 1, ...o }); closers.push(h); return h; };
after(async () => { for (const h of closers) await h.close(); });
// act from a chosen network address (the app runs behind a proxy, as in production)
const from = (h, ip) => { const c = h.client(); const req = c.req.bind(c); c.req = (m, p, b, o = {}) => req(m, p, b, { ...o, headers: { ...(o.headers || {}), 'x-forwarded-for': ip } }); c.post = (p, b = {}) => c.req('POST', p, b); c.get = p => c.req('GET', p); return c; };
const login = (c, u, pw) => c.post('/api/auth/login', { username: u, password: pw });

test('a burst of PARALLEL wrong guesses cannot get through: only a few are ever evaluated, and a correct password during the burst is refused', async () => {
  const h = await mk({ lockoutMaxFailures: 5 }); const u = await h.makeUser('technician', 'burst'); const c = from(h, '10.0.0.1');
  const wrong = await Promise.all(Array.from({ length: 100 }, () => login(c, 'burst', 'wrong-password-12')));
  assert.equal(wrong.filter(r => r.status === 401).length <= 5, true, `only the allowed few guesses were checked (got ${wrong.filter(r => r.status === 401).length})`);
  assert.ok(wrong.filter(r => r.status === 429).length >= 95);
  assert.equal(h.db.prepare("SELECT count FROM login_failures WHERE key LIKE 'ip:%'").get().count <= 101, true);
  assert.equal((await login(c, 'burst', PW)).status, 429, 'locked even for the right password');
  const mixed = await Promise.all([...Array.from({ length: 30 }, () => login(from(h, '10.0.0.2'), 'burst', 'wrong-password-12')), login(from(h, '10.0.0.2'), 'burst', PW)]);
  assert.ok(!mixed.some(r => r.status === 200), 'no session was handed out during a guessing burst');
});

test('a stranger cannot lock you out: failures from another address do not stop the real person signing in', async () => {
  const h = await mk({ lockoutMaxFailures: 5, lockoutGlobalFailures: 20 }); const u = await h.makeUser('admin', 'theboss');
  const attacker = from(h, '203.0.113.9');
  for (let i = 0; i < 8; i++) await login(attacker, 'theboss', 'wrong-password-12');
  assert.equal((await login(attacker, 'theboss', PW)).status, 429, 'the attacker\'s own address is locked');
  const real = await login(from(h, '198.51.100.7'), 'theboss', PW); assert.equal(real.status, 200, 'the real person, from their own address, is not affected');
  assert.ok(real.body.user, 'and gets a real session');
});

test('many addresses guessing at one account still hit a ceiling (the per-username limit)', async () => {
  const h = await mk({ lockoutMaxFailures: 5, lockoutGlobalFailures: 12 }); await h.makeUser('technician', 'swarmed');
  for (let i = 0; i < 12; i++) await login(from(h, `192.0.2.${i + 1}`), 'swarmed', 'wrong-password-12');
  const r = await login(from(h, '198.51.100.7'), 'swarmed', PW); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'ACCOUNT_LOCKED');
});

test('a legitimate person who fumbles a few times then gets it right is let in and starts fresh', async () => {
  const h = await mk({ lockoutMaxFailures: 5 }); await h.makeUser('technician', 'fumbler'); const c = from(h, '10.1.1.1');
  for (let i = 0; i < 4; i++) assert.equal((await login(c, 'fumbler', 'wrong-password-12')).status, 401);
  assert.equal((await login(c, 'fumbler', PW)).status, 200, 'the 5th attempt (correct) works');
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM login_failures WHERE key LIKE 'ip:%'").get().n, 0, 'their own failures are forgotten');
  for (let i = 0; i < 4; i++) assert.equal((await login(from(h, '10.1.1.1'), 'fumbler', 'wrong-password-12')).status, 401, 'a fresh allowance');
});

test('admin unlock and password reset clear the lock for every address', async () => {
  const h = await mk({ lockoutMaxFailures: 3 }); const ac = await h.as(await h.makeUser('admin')); const u = await h.makeUser('technician', 'lockedguy');
  for (const ip of ['10.2.0.1', '10.2.0.2']) for (let i = 0; i < 4; i++) await login(from(h, ip), 'lockedguy', 'wrong-password-12');
  assert.equal((await login(from(h, '10.2.0.1'), 'lockedguy', PW)).status, 429); assert.equal((await login(from(h, '10.2.0.2'), 'lockedguy', PW)).status, 429);
  assert.equal((await ac.post(`/api/users/${u.id}/unlock`)).status, 200);
  assert.equal((await login(from(h, '10.2.0.1'), 'lockedguy', PW)).status, 200); assert.equal((await login(from(h, '10.2.0.2'), 'lockedguy', PW)).status, 200);
  for (let i = 0; i < 4; i++) await login(from(h, '10.2.0.3'), 'lockedguy', 'wrong-password-12');
  const rs = await ac.post(`/api/users/${u.id}/reset-password`); assert.equal(rs.status, 200);
  assert.equal((await login(from(h, '10.2.0.3'), 'lockedguy', rs.body.temporary_password)).status, 200, 'reset also unlocks');
});

test('a locked account shows that to administrators (who is locked, until when)', async () => {
  const h = await mk({ lockoutMaxFailures: 3 }); const ac = await h.as(await h.makeUser('admin')); await h.makeUser('technician', 'visiblylocked'); await h.makeUser('technician', 'fine');
  for (let i = 0; i < 4; i++) await login(from(h, '10.3.0.1'), 'visiblylocked', 'wrong-password-12');
  const users = (await ac.get('/api/users')).body.users, a = users.find(x => x.username === 'visiblylocked'), b = users.find(x => x.username === 'fine');
  assert.equal(a.locked, true); assert.ok(a.locked_minutes >= 1 && a.locked_minutes <= 15); assert.equal(b.locked, false); assert.ok('last_login_at' in a);
});
