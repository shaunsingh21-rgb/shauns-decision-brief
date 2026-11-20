'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness, PW } = require('../helpers');

let h, admin;
before(async () => { h = await harness(); admin = await h.makeUser('admin'); });
after(() => h.close());

test('login sets an httpOnly SameSite cookie and never returns password hashes', async () => {
  const c = h.client(); const r = await c.login(admin);
  assert.equal(r.status, 200);
  assert.match(r.setCookie[0], /HttpOnly/i); assert.match(r.setCookie[0], /SameSite=Lax/i);
  assert.ok(!JSON.stringify(r.body).includes('password_hash'));
  const users = await c.get('/api/users');
  assert.ok(!JSON.stringify(users.body).includes('argon2'));
});

test('wrong password and unknown user give the same message (no account enumeration)', async () => {
  const c = h.client();
  const a = await c.login(admin.username, 'wrong-password-xx');
  const b = await c.login('nobody-here', 'wrong-password-xx');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error.message, b.body.error.message);
});

test('lockout: 3 failures lock the account, even the correct password is refused, admin unlock restores', async () => {
  const victim = await h.makeUser('technician', 'locky');
  const c = h.client();
  for (let i = 0; i < 3; i++) assert.equal((await c.login('locky', 'bad-password-1234')).status, 401);
  const locked = await c.login('locky', PW);
  assert.equal(locked.status, 429); assert.equal(locked.body.error.code, 'ACCOUNT_LOCKED');
  const ac = await h.as(admin);
  assert.equal((await ac.post(`/api/users/${victim.id}/unlock`)).status, 200);
  assert.equal((await c.login('locky', PW)).status, 200);
  const log = await ac.get('/api/audit');
  assert.ok(log.body.entries.some(e => e.action === 'auth.lockout'));
});

test('lockout also applies to unknown usernames (same behaviour as real ones)', async () => {
  const c = h.client();
  for (let i = 0; i < 3; i++) await c.login('ghost-user', 'bad-password-1234');
  assert.equal((await c.login('ghost-user', 'bad-password-1234')).status, 429);
});

test('lockout expires after the lockout window', async () => {
  await h.makeUser('technician', 'expiry');
  const c = h.client();
  for (let i = 0; i < 3; i++) await c.login('expiry', 'bad-password-1234');
  assert.equal((await c.login('expiry', PW)).status, 429);
  h.db.prepare("UPDATE login_failures SET locked_until=? WHERE key='expiry'").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await c.login('expiry', PW)).status, 200);
});

test('first login forces a password change; everything else is blocked until then', async () => {
  const u = await h.makeUser('technician', 'newbie', { mustChange: true });
  const c = await h.as(u);
  const blocked = await c.get('/api/equipment');
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await c.get('/api/me')).body.user.must_change_password, true);
  assert.equal((await c.post('/api/auth/change-password', { current_password: PW, new_password: 'short' })).status, 400);
  assert.equal((await c.post('/api/auth/change-password', { current_password: 'wrong-current-pw', new_password: 'A-brand-new-passphrase' })).status, 403);
  assert.equal((await c.post('/api/auth/change-password', { current_password: PW, new_password: 'A-brand-new-passphrase' })).status, 200);
  assert.equal((await c.get('/api/equipment')).status, 200);
});

test('changing password signs out other sessions', async () => {
  const u = await h.makeUser('technician', 'multi');
  const a = await h.as(u), b = await h.as(u);
  assert.equal((await b.post('/api/auth/change-password', { current_password: PW, new_password: 'Another-long-passphrase' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await b.get('/api/me')).status, 200);
});

test('admin creates user with one-time temp password; reset forces change and clears lock', async () => {
  const ac = await h.as(admin);
  const made = await ac.post('/api/users', { username: 'new.tech', display_name: 'New Tech', role: 'technician' });
  assert.equal(made.status, 201); assert.ok(made.body.temporary_password.length >= 12);
  const c = h.client();
  assert.equal((await c.login('new.tech', made.body.temporary_password)).body.user.must_change_password, true);
  const rs = await ac.post(`/api/users/${made.body.user.id}/reset-password`);
  assert.equal(rs.status, 200);
  assert.equal((await c.get('/api/me')).status, 401, 'old session killed by reset');
  assert.equal((await h.client().login('new.tech', made.body.temporary_password)).status, 401);
  assert.equal((await h.client().login('new.tech', rs.body.temporary_password)).status, 200);
  const audit = JSON.stringify((await ac.get('/api/audit')).body);
  assert.ok(!audit.includes(made.body.temporary_password) && !audit.includes(rs.body.temporary_password), 'passwords never in audit log');
  assert.equal((await ac.post('/api/users', { username: 'new.tech', display_name: 'x', role: 'viewer' })).status, 409);
});

test('logout destroys the session; disabling a user kills their sessions', async () => {
  const u = await h.makeUser('viewer', 'leaver');
  const c = await h.as(u); const ac = await h.as(admin);
  assert.equal((await ac.patch(`/api/users/${u.id}`, { disabled: true })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await h.client().login(u)).status, 401);
  const v = await h.makeUser('viewer', 'logout-me'); const vc = await h.as(v);
  assert.equal((await vc.post('/api/auth/logout')).status, 200);
  assert.equal((await vc.get('/api/me')).status, 401);
});

test('the last active admin cannot be demoted or disabled', async () => {
  const solo = await harness(); const a = await solo.makeUser('admin'); const ac = await solo.as(a);
  assert.equal((await ac.patch(`/api/users/${a.id}`, { role: 'viewer' })).status, 409);
  assert.equal((await ac.patch(`/api/users/${a.id}`, { disabled: true })).status, 409);
  await solo.close();
});

test('mass-assignment and bad input are rejected', async () => {
  const ac = await h.as(admin);
  assert.equal((await ac.post('/api/users', { username: 'x y', display_name: 'a', role: 'technician' })).status, 400);
  assert.equal((await ac.post('/api/users', { username: 'okname', display_name: 'a', role: 'god' })).status, 400);
  assert.equal((await ac.post('/api/users', { username: 'okname2', display_name: 'a', role: 'viewer', password_hash: 'x' })).status, 400);
});
