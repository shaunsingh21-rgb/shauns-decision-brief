'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../server/lib/totp');

test('TOTP matches the official RFC 6238 test vectors (SHA-1, 8 digits)', () => {
  const k = Buffer.from('12345678901234567890');
  for (const [secs, want] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']])
    assert.equal(T.hotp(k, Math.floor(secs / 30), 8), want, `T=${secs}`);
});
test('HOTP matches the RFC 4226 vectors, and base32 matches RFC 4648', () => {
  const k = Buffer.from('12345678901234567890');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(c => T.hotp(k, c)), ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']);
  assert.equal(T.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI'); assert.equal(T.base32Decode('MZXW6YTBOI').toString(), 'foobar');
  assert.equal(T.base32Decode('mzxw 6ytb-oi').toString(), 'foobar', 'spaces, dashes and case are ignored (people type these)'); assert.throws(() => T.base32Decode('!!!'));
  const s = T.newSecret(); assert.deepEqual(T.base32Decode(T.base32Encode(s)), s); assert.equal(s.length, 20);
});
test('verification: one 30-second step of drift either way is accepted, more is not, and a code can never be used twice', () => {
  const k = T.newSecret(), now = Date.UTC(2026, 5, 1, 12, 0, 0), step = T.stepOf(now), at = s => T.hotp(k, s);
  assert.equal(T.verifyTotp(k, at(step), { nowMs: now }), step);
  assert.equal(T.verifyTotp(k, at(step - 1), { nowMs: now }), step - 1); assert.equal(T.verifyTotp(k, at(step + 1), { nowMs: now }), step + 1);
  assert.equal(T.verifyTotp(k, at(step - 2), { nowMs: now }), null); assert.equal(T.verifyTotp(k, at(step + 2), { nowMs: now }), null);
  assert.equal(T.verifyTotp(k, at(step), { nowMs: now, lastStep: step }), null, 'replay of the step already used');
  assert.equal(T.verifyTotp(k, at(step - 1), { nowMs: now, lastStep: step }), null, 'an OLDER step than the last used is refused too');
  assert.equal(T.verifyTotp(k, at(step + 1), { nowMs: now, lastStep: step }), step + 1, 'a newer one is fine');
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 5x']) assert.equal(T.verifyTotp(k, bad, { nowMs: now }), null, String(bad));
  assert.equal(T.verifyTotp(k, ` ${at(step).slice(0, 3)} ${at(step).slice(3)} `, { nowMs: now }), step, 'spaces in the typed code are fine');
});
test('secrets are encrypted with AES-256-GCM: round-trips, differs every time, and tampering or a wrong key is detected', () => {
  const key = 'ab12'.repeat(16), other = 'cd34'.repeat(16), secret = T.newSecret();
  const a = T.encrypt(secret, key), b = T.encrypt(secret, key);
  assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/); assert.notEqual(a, b, 'fresh nonce each time'); assert.deepEqual(T.decrypt(a, key), secret);
  assert.ok(!a.includes(T.base32Encode(secret)) && !a.includes(secret.toString('base64url')), 'plaintext is not visible');
  assert.throws(() => T.decrypt(a, other)); const parts = a.split('.'); parts[3] = Buffer.from('x'.repeat(20)).toString('base64url'); assert.throws(() => T.decrypt(parts.join('.'), key));
  assert.throws(() => T.encrypt(secret, 'short'), /64 hex/); assert.throws(() => T.encrypt(secret, 'zz'.repeat(32)), /64 hex/);
});
test('recovery codes: readable format, enough randomness, hashed independently of case and dashes', () => {
  const codes = new Set(Array.from({ length: 500 }, () => T.newRecoveryCode())); assert.equal(codes.size, 500);
  for (const c of codes) assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  const c = [...codes][0]; assert.equal(T.hashRecovery(c), T.hashRecovery(c.toUpperCase().replace('-', ' '))); assert.notEqual(T.hashRecovery(c), T.hashRecovery([...codes][1]));
  assert.ok(!T.hashRecovery(c).includes(T.normaliseRecovery(c)));
});
test('the otpauth link carries issuer, account and parameters in the form authenticator apps expect', () => {
  const u = T.otpauthUri({ issuer: 'AVL Tech Hub', account: 'jo@x', secretB32: 'ABCDEFGH' });
  assert.equal(u, 'otpauth://totp/AVL%20Tech%20Hub:jo%40x?secret=ABCDEFGH&issuer=AVL%20Tech%20Hub&algorithm=SHA1&digits=6&period=30');
});
