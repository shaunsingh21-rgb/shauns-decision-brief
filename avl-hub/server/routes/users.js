'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, username, parse } = require('../lib/validate');
const { KEYS } = require('../lib/permissions');
const { checkPasswordPolicy, generatePassword } = require('./auth');

const cols = 'id,username,display_name,role,must_change_password,auth_provider,disabled,created_at,last_login_at';
// Power rules: a person managing people can only touch people (and hand out roles) with no more power than their own.
const TOO_MUCH = 'That would give more power than your own role has, so only someone with a more powerful role can do it.';

module.exports = function userRoutes(api, ctx) {
  const { P } = api;
  const { db, config, audit, auth } = ctx;
  const limits = require('../middleware/limits')(config);
  const roles = ctx.roles;
  const withRole = u => u && ({ ...u, role_name: (roles.get(u.role) || {}).name || u.role });
  const get = uid => withRole(db.prepare(`SELECT ${cols} FROM users WHERE id=?`).get(uid));
  // Who is locked out right now (any address), so an administrator can see it instead of guessing.
  const lockInfo = name => {
    const k = name.toLowerCase(), pre = `ip:${k}|`;
    const rows = db.prepare('SELECT locked_until FROM login_failures WHERE (key=? OR substr(key,1,?)=?) AND locked_until > ?').all(`all:${k}`, pre.length, pre, new Date().toISOString());
    return rows.length ? { locked: true, locked_minutes: Math.max(1, Math.ceil((Math.max(...rows.map(r => Date.parse(r.locked_until))) - Date.now()) / 60000)) } : { locked: false, locked_minutes: 0 };
  };
  const roleOk = rid => { if (!roles.get(rid)) throw new HttpError(400, 'BAD_ROLE', 'That role does not exist.'); };
  const mayAssign = (req, rid) => { if (!roles.outranks(req.permissions, rid)) throw new HttpError(403, 'TOO_POWERFUL', TOO_MUCH); };
  const mayManage = (req, u) => { if (!roles.outranks(req.permissions, u.role)) throw new HttpError(403, 'TOO_POWERFUL', 'This person’s role has more power than yours, so you cannot change their account.'); };
  const activeAdmins = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n;
  const need = uid => { const u = get(uid); if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found.'); return u; };

  api.get('/users', P('users.manage'), async (req, res) => res.json({ users: db.prepare(`SELECT ${cols} FROM users ORDER BY username`).all().map(u => ({ ...withRole(u), can_manage: roles.outranks(req.permissions, u.role), mfa_enabled: ctx.mfa.enabled(u.id), ...lockInfo(u.username) })) }));

  // Directory visible to every signed-in user (needed for trainee pickers); no sensitive columns.
  api.get('/people', 'any', async (_req, res) =>
    res.json({ people: db.prepare('SELECT id,display_name,role FROM users WHERE disabled=0 ORDER BY display_name').all()
      .map(p => ({ id: p.id, display_name: p.display_name, role_name: (roles.get(p.role) || {}).name || p.role, can_train: roles.permissionsOf(p.role).has('training.take') })) }));

  api.post('/users', P('users.manage'), limits.sensitive, async (req, res) => {
    const b = parse(z.object({ username, display_name: text(80, 1), role: id.or(z.string().regex(/^[a-z]{3,20}$/)), temporary_password: z.string().max(256).optional() }).strict(), req.body);
    roleOk(b.role); mayAssign(req, b.role);
    const temp = b.temporary_password || generatePassword();
    checkPasswordPolicy(config, temp, b.username);
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(b.username)) throw new HttpError(409, 'USERNAME_TAKEN', 'That username already exists.');
    const hash = await auth.provider.hashPassword(temp);
    const uid = crypto.randomUUID(), now = new Date().toISOString();
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,must_change_password,auth_provider,created_at,updated_at)
                    VALUES (?,?,?,?,?,1,'local',?,?)`).run(uid, b.username, b.display_name, b.role, hash, now, now);
        audit(req, 'user.create', 'user', uid, { username: b.username, role: b.role });
      })();
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'USERNAME_TAKEN', 'That username already exists.'); throw e; }     // two admins (or a double-click) creating the same name at once
    // The temporary password is shown exactly once, to the admin, and is never stored in plain text.
    res.status(201).json({ user: get(uid), temporary_password: temp });
  });

  api.patch('/users/:id', P('users.manage'), limits.sensitive, async (req, res) => {
    const uid = parse(id, req.params.id);
    const b = parse(z.object({ display_name: text(80, 1).optional(), role: id.or(z.string().regex(/^[a-z]{3,20}$/)).optional(), disabled: z.boolean().optional() }).strict(), req.body);
    const cur = need(uid); mayManage(req, cur);
    if (b.role) { roleOk(b.role); mayAssign(req, b.role); }
    // Moving someone out of a role that requires two-step sign-in is changing that policy for them: only a Leader/Admin may do it.
    if (b.role && b.role !== cur.role && (roles.get(cur.role) || {}).require_mfa && !(roles.get(b.role) || {}).require_mfa && req.permissions.size < KEYS.length)
      throw new HttpError(403, 'TOO_POWERFUL', 'Only a Leader/Admin can move someone out of a role that requires two-step sign-in.');
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

  api.post('/users/:id/reset-password', P('users.manage'), limits.sensitive, async (req, res) => {
    const uid = parse(id, req.params.id);
    const cur = need(uid); mayManage(req, cur);       // otherwise anyone who can manage people could take over an administrator's account
    if (cur.auth_provider !== 'local') throw new HttpError(400, 'NOT_LOCAL', 'This account does not use a local password.');
    const temp = generatePassword();
    const hash = await auth.provider.hashPassword(temp);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=?, must_change_password=1, updated_at=? WHERE id=?').run(hash, new Date().toISOString(), uid);
      auth.sessions.destroyAllForUser(uid);
      auth.provider.clearAll(cur.username);
      audit(req, 'user.reset_password', 'user', uid);
    })();
    res.json({ temporary_password: temp });
  });

  // Lost phone: turns two-step sign-in off for that person (they can enrol again; if their role requires it, they must). Needs no more power than theirs.
  api.post('/users/:id/mfa-reset', P('users.manage'), limits.sensitive, async (req, res) => {
    const cur = need(parse(id, req.params.id)); mayManage(req, cur);
    db.transaction(() => { ctx.mfa.remove(cur.id); auth.sessions.destroyAllForUser(cur.id); audit(req, 'mfa.reset', 'user', cur.id); })();
    res.json({ ok: true });
  });

  api.post('/users/:id/unlock', P('users.manage'), limits.sensitive, async (req, res) => {
    const cur = need(parse(id, req.params.id)); mayManage(req, cur);
    db.transaction(() => {
      auth.provider.clearAll(cur.username);
      audit(req, 'user.unlock', 'user', cur.id);
    })();
    res.json({ ok: true });
  });

  // ---- admin-listed official source domains ----
  const { domain } = require('../lib/validate');
  api.get('/sources', 'any', async (_req, res) =>
    res.json({ domains: db.prepare('SELECT domain,created_at FROM source_domains ORDER BY domain').all() }));
  api.post('/sources', P('sources.manage'), async (req, res) => {
    const b = parse(z.object({ domain }).strict(), req.body);
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO source_domains VALUES (?,?,?)').run(b.domain, req.user.id, new Date().toISOString());
      audit(req, 'source.add', 'source_domain', b.domain);
    })();
    res.status(201).json({ domain: b.domain });
  });
  api.delete('/sources/:domain', P('sources.manage'), async (req, res) => {
    const d = parse(z.object({ domain }), { domain: req.params.domain }).domain;
    db.transaction(() => {
      db.prepare('DELETE FROM source_domains WHERE domain=?').run(d);
      audit(req, 'source.remove', 'source_domain', d);
    })();
    res.json({ ok: true });
  });

  api.get('/audit', P('audit.view'), async (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
    // Names for what each entry is about, so the screen can say who and what instead of showing ids.
    const one = (sql, v) => { const r = db.prepare(sql).get(v); return r ? Object.values(r)[0] : null; };
    const nameOf = { user: v => one('SELECT username FROM users WHERE id=?', v), role: v => (roles.get(v) || {}).name || null, equipment: v => one('SELECT name FROM equipment WHERE id=?', v),
      module: v => one('SELECT title FROM training_modules WHERE id=?', v), panel: v => one('SELECT title FROM photo_panels WHERE id=?', v), issue: v => one('SELECT title FROM issues WHERE id=?', v),
      file: v => one('SELECT original_name FROM files WHERE id=?', v), source_domain: v => v };
    const rows = db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit);
    // Scores, quiz results and trainer notes are private training data: callers who cannot view progress do not get them through the log either.
    const scrub = e => { if (req.permissions.has('progress.view_all') || !/^(signoff|score|quiz)\./.test(e.action)) return e;
      try { const d = JSON.parse(e.detail); for (const k of ['note', 'scores', 'quiz_pct', 'score']) delete d[k]; return { ...e, detail: JSON.stringify(d) }; } catch { return { ...e, detail: '{}' }; } };
    res.json({ entries: rows.map(scrub).map(e => ({ ...e, target: e.entity && e.entity_id && nameOf[e.entity] ? nameOf[e.entity](e.entity_id) : null })), has_more: rows.length === limit });
  });
};
