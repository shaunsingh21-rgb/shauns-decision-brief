'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { harness, PW } = require('../helpers');
const { createApp } = require('../../server');
const T = require('../../server/lib/totp');

const KEY = 'ab12'.repeat(16);
let t = Date.UTC(2026, 10, 20, 12, 0, 0); const clock = () => t, adv = s => { t += s * 1000; };      // a controllable clock: tests step through 30-second windows
const code = (secret, atMs = t) => T.hotp(T.base32Decode(secret.replace(/\s/g, '')), T.stepOf(atMs));
const closers = []; const mk = async (o = {}) => { const h = await harness({ mfaEncryptionKey: KEY, clock, ...o }); closers.push(h); return h; };
after(async () => { for (const h of closers) await h.close(); });

async function enrol(h, user) {
  const c = await h.as(user); const s = await c.post('/api/auth/mfa/setup', { password: PW }); assert.equal(s.status, 200, JSON.stringify(s.body));
  adv(30); const e = await c.post('/api/auth/mfa/enable', { code: code(s.body.secret) }); assert.equal(e.status, 200, JSON.stringify(e.body));
  return { c, secret: s.body.secret, codes: e.body.recovery_codes };
}
const firstStep = async (h, user) => { const c = h.client(); const r = await c.login(user); return { c, r }; };
async function fullLogin(h, user, secret) { const { c, r } = await firstStep(h, user); adv(30); const v = await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: code(secret) }); return { c, r, v }; }

test('it is OFF unless the server has a key: everything says so plainly and sign-in is unchanged', async () => {
  const h = await mk({ mfaEncryptionKey: null }); const u = await h.makeUser('technician'); const c = await h.as(u);
  assert.deepEqual((await c.get('/api/auth/mfa')).body, { available: false, enabled: false, required_by_role: false, recovery_codes_left: 0 });
  assert.equal((await c.post('/api/auth/mfa/setup', { password: PW })).body.error.code, 'MFA_NOT_CONFIGURED');
  assert.equal((await c.get('/api/me')).body.user.features.mfa, false); assert.equal((await c.get('/api/me')).body.user.mfa_enabled, false);
});
test('a malformed key stops the server from starting (rather than silently weakening it)', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', mfaEncryptionKey: 'not-a-key' }), /64 hex/);
  assert.throws(() => createApp({ dbPath: ':memory:', mfaEncryptionKey: 'zz'.repeat(32) }), /64 hex/);
});

test('ENROLMENT: needs the password; shows a QR code and a typed key; only turns on after a real code; gives recovery codes once; secret stored encrypted', async () => {
  const h = await mk(); const u = await h.makeUser('technician', 'enrol1'); const c = await h.as(u); const other = await h.as(u);
  assert.equal((await c.post('/api/auth/mfa/setup', { password: 'wrong-password-123' })).body.error.code, 'WRONG_PASSWORD');
  assert.equal((await c.post('/api/auth/mfa/enable', { code: '123456' })).body.error.code, 'NOT_STARTED');
  const s = await c.post('/api/auth/mfa/setup', { password: PW }); assert.equal(s.status, 200);
  assert.match(s.body.qr, /^data:image\/png;base64,/); assert.match(s.body.otpauth_uri, /^otpauth:\/\/totp\/AVL%20Tech%20Hub:enrol1\?secret=[A-Z2-7]+&issuer=/); assert.match(s.body.secret, /^([A-Z2-7]{4} ?)+$/);
  assert.equal((await c.get('/api/auth/mfa')).body.enabled, false, 'not on until a code is proven');
  adv(30); assert.equal((await c.post('/api/auth/mfa/enable', { code: '000000' })).body.error.code, 'INVALID_CODE'); assert.equal((await c.get('/api/auth/mfa')).body.enabled, false);
  const e = await c.post('/api/auth/mfa/enable', { code: code(s.body.secret) }); assert.equal(e.status, 200); assert.equal(e.body.recovery_codes.length, 8); assert.ok(e.body.recovery_codes.every(x => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(x)));
  assert.deepEqual((await c.get('/api/auth/mfa')).body, { available: true, enabled: true, required_by_role: false, recovery_codes_left: 8 });
  assert.equal((await c.get('/api/me')).body.user.mfa_enabled, true);
  assert.equal((await other.get('/api/me')).status, 401, 'other devices are signed out when it is turned on');
  const row = h.db.prepare('SELECT * FROM user_mfa').get(); const plain = s.body.secret.replace(/\s/g, '');
  assert.ok(row.secret_enc.startsWith('v1.') && !row.secret_enc.includes(plain), 'the secret is encrypted at rest');
  assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM mfa_recovery_codes').all()).includes(e.body.recovery_codes[0]), 'recovery codes are stored hashed');
  assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()).includes(plain), 'secret never in the audit log');
  assert.equal((await c.post('/api/auth/mfa/setup', { password: PW })).body.error.code, 'ALREADY_ENABLED');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='mfa.enabled' AND actor_id=?").get(u.id));
});

test('SIGN-IN with two steps: the password alone gives NO session; a valid code does; a challenge works once; a code cannot be replayed', async () => {
  const h = await mk(); const u = await h.makeUser('technician', 'two.step'); const { secret } = await enrol(h, u);
  const { c, r } = await firstStep(h, u);
  assert.equal(r.status, 200); assert.equal(r.body.mfa_required, true); assert.ok(r.body.challenge && !r.body.user); assert.deepEqual(r.setCookie, [], 'no session cookie yet');
  assert.equal((await c.get('/api/me')).status, 401); assert.equal((await c.get('/api/equipment')).status, 401);
  adv(30); const wrong = await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: '000000' }); assert.equal(wrong.status, 401); assert.equal(wrong.body.error.code, 'INVALID_CODE');
  const good = code(secret); const v = await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: good });
  assert.equal(v.status, 200); assert.equal(v.body.user.mfa_enabled, true); assert.match(v.setCookie[0], /HttpOnly/i); assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: code(secret, t + 30000) })).body.error.code, 'CHALLENGE_EXPIRED', 'a ticket is single-use');
  await c.post('/api/auth/logout'); const again = h.client(); const r2 = await again.login(u);
  assert.equal((await again.post('/api/auth/mfa/verify', { challenge: r2.body.challenge, code: good })).status, 401, 'the SAME code cannot be used again');
  adv(30); assert.equal((await again.post('/api/auth/mfa/verify', { challenge: r2.body.challenge, code: code(secret) })).status, 200, 'a fresh code works');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='auth.mfa_failed'").get()); assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='auth.login' AND detail LIKE '%\"mfa\":\"app\"%'").get());
});

test('clock drift: one step either side is fine; three steps is not', async () => {
  const h = await mk(); const u = await h.makeUser('technician', 'drift'); const { secret } = await enrol(h, u);
  for (const [shift, ok] of [[-30000, true], [+30000, true], [-90000, false], [+90000, false]]) {
    adv(60); const { c, r } = await firstStep(h, u); const res = await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: code(secret, t + shift) });
    assert.equal(res.status, ok ? 200 : 401, `shift ${shift}`);
  }
});

test('guessing is stopped three ways: 5 tries per ticket, a 5-minute ticket life, and the shared account lockout', async () => {
  const h = await mk({ lockoutMaxFailures: 4 }); const u = await h.makeUser('technician', 'guessy'); const { secret } = await enrol(h, u);
  const { c, r } = await firstStep(h, u);
  // the password step counts as 1 attempt, so with a limit of 4 the 3rd wrong code reaches it
  for (let i = 0; i < 2; i++) assert.equal((await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: '111111' })).body.error.code, 'INVALID_CODE');
  const fourth = await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: '111111' });
  assert.ok(['CHALLENGE_EXPIRED', 'ACCOUNT_LOCKED'].includes(fourth.body.error.code));
  adv(30); const locked = await h.client().login(u); assert.equal(locked.status, 429, 'wrong codes count toward the same lockout as wrong passwords'); assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
  h.db.prepare("DELETE FROM login_failures").run();
  const h2 = await mk(); const u2 = await h2.makeUser('technician', 'ticket'); const e2 = await enrol(h2, u2); const f = await firstStep(h2, u2);
  for (let i = 0; i < 4; i++) await f.c.post('/api/auth/mfa/verify', { challenge: f.r.body.challenge, code: '222222' });
  adv(30); assert.equal((await f.c.post('/api/auth/mfa/verify', { challenge: f.r.body.challenge, code: code(e2.secret) })).status, 401, 'after 5 attempts the ticket is dead even with the right code');
  h2.db.prepare('DELETE FROM login_failures').run();                                                       // the guesses above legitimately locked the account; start clean
  const g = await firstStep(h2, u2); h2.db.prepare('UPDATE mfa_challenges SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await g.c.post('/api/auth/mfa/verify', { challenge: g.r.body.challenge, code: code(e2.secret) })).body.error.code, 'CHALLENGE_EXPIRED', 'expired ticket');
  assert.equal((await h2.client().post('/api/auth/mfa/verify', { challenge: 'x'.repeat(43), code: '123456' })).body.error.code, 'CHALLENGE_EXPIRED', 'made-up ticket');
});

test('RECOVERY CODES: each works once, any case, count goes down, and using one is audited; regenerating needs password + a code and kills the old set', async () => {
  // this test signs in many times, some deliberately failing, so give it a high limit
  const h = await mk({ lockoutMaxFailures: 50, lockoutGlobalFailures: 100 }); const u = await h.makeUser('technician', 'recover'); const { secret, codes } = await enrol(h, u);
  const useCode = async cd => { const { c, r } = await firstStep(h, u); return { c, res: await c.post('/api/auth/mfa/verify', { challenge: r.body.challenge, code: cd }) }; };
  const a = await useCode(codes[0].toUpperCase()); assert.equal(a.res.status, 200, 'case does not matter'); assert.equal((await a.c.get('/api/auth/mfa')).body.recovery_codes_left, 7);
  assert.equal((await useCode(codes[0])).res.status, 401, 'a recovery code works only once');
  assert.equal((await useCode('aaaaa-bbbbb')).res.status, 401); assert.equal((await useCode(codes[1].replace('-', ' '))).res.status, 200, 'dash or space both fine');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='auth.mfa_recovery_used'").get());
  adv(30); const regen = await a.c.post('/api/auth/mfa/recovery-codes', { password: PW, code: code(secret) }); assert.equal(regen.status, 200); assert.equal(regen.body.recovery_codes.length, 8);
  assert.equal((await useCode(codes[2])).res.status, 401, 'old codes are dead'); assert.equal((await useCode(regen.body.recovery_codes[0])).res.status, 200);
  assert.equal((await a.c.post('/api/auth/mfa/recovery-codes', { password: 'wrong-password-123', code: code(secret, t + 30000) })).status, 403);
});

test('TURNING IT OFF needs the password and a current code, signs other devices out, and is refused if the role requires it', async () => {
  const h = await mk(); const u = await h.makeUser('technician', 'offer'); const { c, secret } = await enrol(h, u); const other = (await fullLogin(h, u, secret)).c;
  assert.equal((await c.post('/api/auth/mfa/disable', { password: 'wrong-password-123', code: code(secret, t + 30000) })).status, 403);
  adv(30); assert.equal((await c.post('/api/auth/mfa/disable', { password: PW, code: '000000' })).body.error.code, 'INVALID_CODE'); assert.equal((await c.get('/api/auth/mfa')).body.enabled, true);
  assert.equal((await c.post('/api/auth/mfa/disable', { password: PW, code: code(secret) })).status, 200);
  assert.equal((await other.get('/api/me')).status, 401); const plain = await h.client().login(u); assert.equal(plain.status, 200); assert.ok(plain.body.user && !plain.body.mfa_required, 'back to password-only');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM user_mfa').get().n + h.db.prepare('SELECT COUNT(*) n FROM mfa_recovery_codes').get().n, 0, 'secrets and codes are removed');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='mfa.disabled'").get());
});

test('ROLES CAN REQUIRE IT: people in that role can do nothing but enrol until they have; then they are through; they cannot turn it off', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin')); const role = (await ac.post('/api/roles', { name: 'Needs Two Step', permissions: ['equipment.edit'], require_mfa: true })).body.role;
  assert.equal(role.require_mfa, true); const u = await h.makeUser(role.id, 'must.enrol'); const c = await h.as(u);
  const me = (await c.get('/api/me')).body.user; assert.equal(me.must_enroll_mfa, true); assert.equal(me.mfa_enabled, false);
  for (const [m, p] of [['get', '/api/equipment'], ['get', '/api/modules'], ['post', '/api/equipment'], ['get', '/api/issues']]) { const r = await c[m](p, {}); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'MFA_ENROLLMENT_REQUIRED', p); }
  assert.equal((await c.get('/api/auth/mfa')).status, 200); const s = await c.post('/api/auth/mfa/setup', { password: PW }); assert.equal(s.status, 200); adv(30);
  const e = await c.post('/api/auth/mfa/enable', { code: code(s.body.secret) }); assert.equal(e.status, 200);
  assert.equal((await c.get('/api/equipment')).status, 200); assert.equal((await c.post('/api/equipment', { name: 'SAMPLE', fields: [] })).status, 201);
  assert.equal((await c.get('/api/me')).body.user.must_enroll_mfa, false);
  adv(30); assert.equal((await c.post('/api/auth/mfa/disable', { password: PW, code: code(s.body.secret) })).body.error.code, 'MFA_REQUIRED_BY_ROLE');
  // an admin turning the requirement on later catches people already signed in, immediately
  const plainRole = (await ac.post('/api/roles', { name: 'Plain', permissions: ['equipment.edit'] })).body.role; const p = await h.as(await h.makeUser(plainRole.id, 'already.in'));
  assert.equal((await p.get('/api/equipment')).status, 200); await ac.patch(`/api/roles/${plainRole.id}`, { require_mfa: true });
  assert.equal((await p.get('/api/equipment')).body.error.code, 'MFA_ENROLLMENT_REQUIRED');
  await ac.patch(`/api/roles/${plainRole.id}`, { require_mfa: false }); assert.equal((await p.get('/api/equipment')).status, 200, 'and switching it off frees them');
});

test('the Leader/Admin role can be required to use it too (and then the admin must enrol first)', async () => {
  const h = await mk(); const a = await h.makeUser('admin'); const c = await h.as(a);
  assert.equal((await c.patch('/api/roles/admin', { require_mfa: true })).status, 200);
  assert.equal((await c.get('/api/roles')).body.error.code, 'MFA_ENROLLMENT_REQUIRED', 'even the admin is held to it');
  const s = await c.post('/api/auth/mfa/setup', { password: PW }); adv(30); assert.equal((await c.post('/api/auth/mfa/enable', { code: code(s.body.secret) })).status, 200);
  assert.equal((await c.get('/api/roles')).status, 200); assert.equal((await c.get('/api/roles')).body.roles.find(r => r.id === 'admin').require_mfa, true);
});

test('ADMIN RESET (lost phone): a people-manager can turn it off for someone with no more power; not for an administrator; it is audited', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin')); const u = await h.makeUser('technician', 'lostphone'); const { secret } = await enrol(h, u); const adminEnrol = await enrol(h, await h.makeUser('admin', 'admin2'));
  const pm = h.makeRole(['users.manage'], 'People Manager'); const pmc = await h.as(await h.makeUser(pm, 'pm1'));
  assert.equal((await pmc.get('/api/users')).body.users.find(x => x.username === 'lostphone').mfa_enabled, true);
  assert.equal((await pmc.post(`/api/users/${h.db.prepare("SELECT id FROM users WHERE username='admin2'").get().id}/mfa-reset`)).status, 403, 'cannot strip an administrator\'s second step (that would help an attacker)');
  assert.equal((await pmc.post(`/api/users/${u.id}/mfa-reset`)).status, 403, 'a technician role has equipment.edit etc. which the people-manager lacks');
  assert.equal((await ac.post(`/api/users/${u.id}/mfa-reset`)).status, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM user_mfa WHERE user_id=?').get(u.id).n, 0); assert.ok((await h.client().login(u)).body.user, 'password-only again');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='mfa.reset' AND entity_id=?").get(u.id)); void secret; void adminEnrol;
});

test('it FAILS CLOSED: a missing key blocks sign-in for enrolled people (no silent bypass); a wrong key or damaged secret rejects codes but recovery codes still work', async () => {
  const h = await mk(); const u = await h.makeUser('technician', 'failclosed'); const { secret, codes } = await enrol(h, u);
  const start = async o => { const app = createApp({ dbPath: h.ctx.config.dbPath, uploadDir: h.ctx.config.uploadDir, clock, ...o }); const srv = await new Promise(r => { const s = app.app.listen(0, '127.0.0.1', () => r(s)); }); closers.push({ close: async () => { await new Promise(r => srv.close(r)); app.close(); } }); return `http://127.0.0.1:${srv.address().port}`; };
  const post = async (base, p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-by': 'avl-hub' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const noKey = await start({ mfaEncryptionKey: null }); const r1 = await post(noKey, '/api/auth/login', { username: 'failclosed', password: PW });
  assert.equal(r1.status, 503); assert.equal(r1.body.error.code, 'MFA_UNAVAILABLE'); assert.ok(!r1.body.user, 'password alone must NOT sign in');
  const wrongKey = await start({ mfaEncryptionKey: 'cd34'.repeat(16) }); adv(30); const r2 = await post(wrongKey, '/api/auth/login', { username: 'failclosed', password: PW });
  assert.equal(r2.body.mfa_required, true); assert.equal((await post(wrongKey, '/api/auth/mfa/verify', { challenge: r2.body.challenge, code: code(secret) })).status, 401, 'cannot decrypt, so no code is accepted');
  const r3 = await post(wrongKey, '/api/auth/login', { username: 'failclosed', password: PW }); assert.equal((await post(wrongKey, '/api/auth/mfa/verify', { challenge: r3.body.challenge, code: codes[0] })).status, 200, 'a recovery code still gets them in');
  h.db.prepare("UPDATE user_mfa SET secret_enc='v1.AAAA.AAAA.AAAA' WHERE user_id=?").run(u.id);
  const ok = await start({ mfaEncryptionKey: KEY }); const r4 = await post(ok, '/api/auth/login', { username: 'failclosed', password: PW });
  assert.equal((await post(ok, '/api/auth/mfa/verify', { challenge: r4.body.challenge, code: code(secret) })).status, 401, 'a damaged secret is a clean failure, not a crash');
});

test('setting it up is rate limited, like password attempts', async () => {
  const h = await mk({ ratePasswordPer15Min: 3 }); const c = await h.as(await h.makeUser('technician'));
  for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/auth/mfa/setup', { password: 'wrong-password-123' })).status, 403);
  assert.equal((await c.post('/api/auth/mfa/setup', { password: PW })).status, 429);
});

test('command line: reset-mfa (server access) removes it for one person, signs them out, and is audited', async () => {
  const h = await mk(); const u = await h.makeUser('admin', 'sole.admin'); await enrol(h, u); h.db.pragma('wal_checkpoint(FULL)');
  const root = path.join(__dirname, '..', '..'), env = { ...process.env, DB_PATH: h.ctx.config.dbPath, UPLOAD_DIR: h.ctx.config.uploadDir, NODE_ENV: '' }, run = (...a) => spawnSync(process.execPath, [path.join(root, 'scripts', 'reset-mfa.js'), ...a], { env, encoding: 'utf8' });
  assert.equal(run().status, 2); assert.equal(run('nobody').status, 1);
  const ok = run('sole.admin'); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /now off/);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM user_mfa').get().n, 0); assert.equal(h.db.prepare("SELECT actor_name FROM audit_log WHERE action='mfa.reset_cli'").get().actor_name, 'cli');
  assert.match(run('sole.admin').stdout, /did not have/); assert.ok((await h.client().login(u)).body.user);
});

test('A NEW PERSON IN A TWO-STEP ROLE CAN GET IN: password change and setup do not wait on each other (found by the pre-launch review)', async () => {
  const h = await mk(); const ac = await h.as(await h.makeUser('admin')); const role = (await ac.post('/api/roles', { name: 'Two Step Staff', permissions: ['equipment.edit'], require_mfa: true })).body.role;
  const made = await ac.post('/api/users', { username: 'brand.new', display_name: 'B', role: role.id }); const temp = made.body.temporary_password;
  const c = h.client(); assert.equal((await c.login('brand.new', temp)).status, 200);
  const me = (await c.get('/api/me')).body.user; assert.deepEqual([me.must_change_password, me.must_enroll_mfa], [true, true]);
  assert.equal((await c.get('/api/equipment')).status, 403, 'nothing else is available yet');
  // either order works: password first …
  const ch = await c.post('/api/auth/change-password', { current_password: temp, new_password: 'A-brand-new-passphrase' }); assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const s = await c.post('/api/auth/mfa/setup', { password: 'A-brand-new-passphrase' }); assert.equal(s.status, 200); adv(30);
  assert.equal((await c.post('/api/auth/mfa/enable', { code: code(s.body.secret) })).status, 200); assert.equal((await c.get('/api/equipment')).status, 200, 'through');
  // … or two-step first (a reset password on someone already in the role)
  const u2 = await ac.post('/api/users', { username: 'other.new', display_name: 'O', role: role.id }); const c2 = h.client(); await c2.login('other.new', u2.body.temporary_password);
  const s2 = await c2.post('/api/auth/mfa/setup', { password: u2.body.temporary_password }); assert.equal(s2.status, 200, JSON.stringify(s2.body)); adv(30);
  assert.equal((await c2.post('/api/auth/mfa/enable', { code: code(s2.body.secret) })).status, 200); assert.equal((await c2.get('/api/equipment')).body.error.code, 'PASSWORD_CHANGE_REQUIRED', 'still must choose a password');
  assert.equal((await c2.post('/api/auth/change-password', { current_password: u2.body.temporary_password, new_password: 'Another-long-passphrase-1' })).status, 200); assert.equal((await c2.get('/api/equipment')).status, 200);
});
