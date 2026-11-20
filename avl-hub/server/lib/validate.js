'use strict';
// Input sanitising. Output escaping is done by the client when rendering; the API only ever returns JSON.
const { z } = require('zod');
const { HttpError } = require('./errors');

const clean = s => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
const text = (max, min = 0) => z.string().transform(clean).pipe(z.string().min(min).max(max));
const id = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'invalid id');
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'invalid key');
const username = z.string().transform(s => s.trim()).pipe(z.string().regex(/^[A-Za-z0-9._@-]{3,64}$/, 'username: 3-64 letters, digits . _ @ -'));
const ROLES = ['admin', 'trainer', 'technician', 'viewer'];
const PROVENANCE = ['manufacturer', 'team', 'ai', 'verify'];

// https only, no credentials, bounded length. Returns the normalised URL string.
function safeUrl(s) {
  if (typeof s !== 'string' || s.length > 2048) return null;
  let u; try { u = new URL(s.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  return u.toString();
}
const url = z.string().refine(s => safeUrl(s) !== null, 'must be a valid https URL').transform(s => safeUrl(s));
const domain = z.string().transform(s => s.trim().toLowerCase())
  .pipe(z.string().regex(/^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, 'invalid domain'));

function parse(schema, data) {
  const r = schema.safeParse(data === undefined ? {} : data);
  if (!r.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid input.', {
      details: r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
function hostMatches(urlStr, domains) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return domains.some(d => h === d || h.endsWith('.' + d));
  } catch { return false; }
}
module.exports = { z, text, id, slug, username, url, domain, safeUrl, parse, hostMatches, ROLES, PROVENANCE };
