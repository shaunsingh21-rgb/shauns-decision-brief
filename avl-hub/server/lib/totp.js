'use strict';
// Time-based one-time passwords (RFC 6238 / RFC 4226) — what Microsoft Authenticator, Google Authenticator, 1Password etc. use.
// Small and dependency-free so it is easy to review. Secrets are encrypted at rest with a key that lives only in an environment variable.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, ''); let bits = 0, value = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter, digits = 6, algo = 'sha1') {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, secret).update(c).digest(); const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
const stepOf = (nowMs, period = 30) => Math.floor(nowMs / 1000 / period);
// Accepts the current 30-second window and one either side (clock drift). Returns the matching step, or null.
// A step at or below `lastStep` is refused, so a code (even one shoulder-surfed) can never be used twice.
function verifyTotp(secret, code, { nowMs = Date.now(), lastStep = 0, window = 1, digits = 6 } = {}) {
  const c = String(code || '').replace(/\s/g, ''); if (!new RegExp(`^\\d{${digits}}$`).test(c)) return null;
  const now = stepOf(nowMs); let hit = null;
  for (let s = now - window; s <= now + window; s++) {                       // check every step (no early exit) so timing does not reveal which matched
    const want = Buffer.from(hotp(secret, s, digits)), got = Buffer.from(c);
    if (crypto.timingSafeEqual(want, got) && s > lastStep && (hit === null || s > hit)) hit = s;
  }
  return hit;
}
const newSecret = () => crypto.randomBytes(20);                              // 160 bits
const otpauthUri = ({ issuer, account, secretB32 }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// AES-256-GCM. Format: v1.<iv>.<tag>.<ciphertext> (base64url). The key is 32 bytes given as 64 hex characters.
const keyBuf = hex => { if (!/^[0-9a-fA-F]{64}$/.test(hex || '')) throw new Error('MFA_ENCRYPTION_KEY must be exactly 64 hex characters. Make one with: openssl rand -hex 32'); return Buffer.from(hex, 'hex'); };
function encrypt(plain, hexKey) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyBuf(hexKey), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((x, i) => (i ? x.toString('base64url') : x)).join('.');
}
function decrypt(blob, hexKey) {
  const [v, iv, tag, ct] = String(blob).split('.'); if (v !== 'v1' || !ct) throw new Error('unrecognised secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf(hexKey), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
}
// Recovery codes: 10 characters from a 32-letter alphabet (50 bits), shown as xxxxx-xxxxx, stored only as a hash, each usable once.
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRecoveryCode() { let s = ''; const b = crypto.randomBytes(10); for (const x of b) s += ALPHA[x % ALPHA.length]; return s.slice(0, 5) + '-' + s.slice(5); }
const normaliseRecovery = c => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = c => crypto.createHash('sha256').update('avl-recovery:' + normaliseRecovery(c)).digest('hex');
module.exports = { base32Encode, base32Decode, hotp, verifyTotp, stepOf, newSecret, otpauthUri, encrypt, decrypt, keyBuf, newRecoveryCode, normaliseRecovery, hashRecovery };
