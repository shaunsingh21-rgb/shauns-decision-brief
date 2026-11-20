'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, username, ROLES, parse } = require('../lib/validate');
const { checkPasswordPolicy, generatePassword } = require('./auth');

const ADMIN = ['admin'];
const cols = 'id,username,display_name,role,must_change_password,auth_provider,disabled,created_at,last_login_at';

module.exports = function userRoutes(api, ctx) {
  const { db, config, audit, auth } = ctx;
  const limits = require('../middleware/limits')(config);
  const get = uid => db.prepare(`SELECT ${cols} FROM users WHERE id=?`).get(uid);
  const activeAdmins = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n;
  const need = uid => { const u = get(uid); if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found.'); return u; };

  api.get('/users', ADMIN, async (_req, res) => res.json({ users: db.prepare(`SELECT ${cols} FROM users ORDER BY username`).all() }));

  // Directory visible to every signed-in user (needed for trainee pickers); no sensitive columns.
  api.get('/people', 'any', async (_req, res) =>
    res.json({ people: db.prepare('SELECT id,display_name,role FROM users WHERE disabled=0 ORDER BY display_name').all() }));

  api.post('/users', ADMIN, limits.sensitive, async (req, res) => {
    const b = parse(z.object({ username, display_name: text(80, 1), role: z.enum(ROLES), temporary_password: z.string().max(256).optional() }).strict(), req.body);
    const temp = b.temporary_password || generatePassword();
    checkPasswordPolicy(config, temp, b.username);
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(b.username)) throw new HttpError(409, 'USERNAME_TAKEN', 'That username already exists.');
    const hash = await auth.provider.hashPassword(temp);
    const uid = crypto.randomUUID(), now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,must_change_password,auth_provider,created_at,updated_at)
                  VALUES (?,?,?,?,?,1,'local',?,?)`).run(uid, b.username, b.display_name, b.role, hash, now, now);
      audit(req, 'user.create', 'user', uid, { username: b.username, role: b.role });
    })();
    // The temporary password is shown exactly once, to the admin, and is never stored in plain text.
    res.status(201).json({ user: get(uid), temporary_password: temp });
  });

  api.patch('/users/:id', ADMIN, limits.sensitive, async (req, res) => {
    const uid = parse(id, req.params.id);
    const b = parse(z.object({ display_name: text(80, 1).optional(), role: z.enum(ROLES).optional(), disabled: z.boolean().optional() }).strict(), req.body);
    const cur = need(uid);
    const losesAdmin = cur.role === 'admin' && !cur.disabled && ((b.role && b.role !== 'admin') || b.disabled === true);
    if (losesAdmin && activeAdmins() <= 1) throw new HttpError(409, 'LAST_ADMIN', 'At least one active administrator is required.');
    db.transaction(() => {
      db.prepare('UPDATE users SET display_name=?, role=?, disabled=?, updated_at=? WHERE id=?').run(
        b.display_name ?? cur.display_name, b.role ?? cur.role, b.disabled === undefined ? cur.disabled : +b.disabled, new Date().toISOString(), uid);
      if (b.disabled === true || (b.role && b.role !== cur.role)) auth.sessions.destroyAllForUser(uid);
      audit(req, 'user.update', 'user', uid, { before: { role: cur.role, disabled: !!cur.disabled }, after: b });
    })();
    res.json({ user: get(uid) });
  });

  api.post('/users/:id/reset-password', ADMIN, limits.sensitive, async (req, res) => {
    const uid = parse(id, req.params.id);
    const cur = need(uid);
    if (cur.auth_provider !== 'local') throw new HttpError(400, 'NOT_LOCAL', 'This account does not use a local password.');
    const temp = generatePassword();
    const hash = await auth.provider.hashPassword(temp);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=?, must_change_password=1, updated_at=? WHERE id=?').run(hash, new Date().toISOString(), uid);
      auth.sessions.destroyAllForUser(uid);
      db.prepare('DELETE FROM login_failures WHERE key=?').run(cur.username.toLowerCase());
      audit(req, 'user.reset_password', 'user', uid);
    })();
    res.json({ temporary_password: temp });
  });

  api.post('/users/:id/unlock', ADMIN, limits.sensitive, async (req, res) => {
    const cur = need(parse(id, req.params.id));
    db.transaction(() => {
      db.prepare('DELETE FROM login_failures WHERE key=?').run(cur.username.toLowerCase());
      audit(req, 'user.unlock', 'user', cur.id);
    })();
    res.json({ ok: true });
  });

  // ---- admin-listed official source domains ----
  const { domain } = require('../lib/validate');
  api.get('/sources', 'any', async (_req, res) =>
    res.json({ domains: db.prepare('SELECT domain,created_at FROM source_domains ORDER BY domain').all() }));
  api.post('/sources', ADMIN, async (req, res) => {
    const b = parse(z.object({ domain }).strict(), req.body);
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO source_domains VALUES (?,?,?)').run(b.domain, req.user.id, new Date().toISOString());
      audit(req, 'source.add', 'source_domain', b.domain);
    })();
    res.status(201).json({ domain: b.domain });
  });
  api.delete('/sources/:domain', ADMIN, async (req, res) => {
    const d = parse(z.object({ domain }), { domain: req.params.domain }).domain;
    db.transaction(() => {
      db.prepare('DELETE FROM source_domains WHERE domain=?').run(d);
      audit(req, 'source.remove', 'source_domain', d);
    })();
    res.json({ ok: true });
  });

  api.get('/audit', ADMIN, async (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
    res.json({ entries: db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit) });
  });
};
