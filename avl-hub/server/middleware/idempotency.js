'use strict';
const { HttpError } = require('../lib/errors');
// Same user + same Idempotency-Key => replay the stored successful response; never run the change twice.
// Replays are never stored for anything that carries a credential or manages access (temporary passwords, recovery codes, roles).
const NEVER_STORE = /^\/api\/(auth|users|roles|admin)(\/|$)/;
module.exports = ({ db }) => (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.user || NEVER_STORE.test(req.originalUrl.split('?')[0])) return next();
  const key = req.get('idempotency-key'); if (!key) return next();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) return next(new HttpError(400, 'BAD_IDEMPOTENCY_KEY', 'Invalid idempotency key.'));
  const path = req.originalUrl.split('?')[0];
  const row = db.prepare('SELECT * FROM idempotency WHERE user_id=? AND key=?').get(req.user.id, key);
  if (row) {
    if (row.method !== req.method || row.path !== path) return next(new HttpError(422, 'IDEMPOTENCY_MISMATCH', 'That key was used for a different request.'));
    res.set('Idempotent-Replay', 'true'); return res.status(row.status).json(JSON.parse(row.body));
  }
  const json = res.json.bind(res);
  res.json = body => {                                             // only successful results are remembered, so a rejection never "sticks"
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const s = JSON.stringify(body);
      if (s.length < 65536) try { db.prepare('INSERT OR IGNORE INTO idempotency VALUES (?,?,?,?,?,?,?)').run(req.user.id, key, req.method, path, res.statusCode, s, new Date().toISOString()); } catch { /* best effort */ }
    }
    return json(body);
  };
  next();
};
