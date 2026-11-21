'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, url, parse } = require('../lib/validate');
const { editTime, superseded } = require('../lib/sync');


module.exports = function issueRoutes(api, ctx) {
  const { P } = api;
  const { db, audit } = ctx;
  const now = () => new Date().toISOString();
  const eqOk = eid => { if (eid && !db.prepare('SELECT 1 FROM equipment WHERE id=? AND deleted_at IS NULL').get(eid)) throw new HttpError(400, 'BAD_EQUIPMENT', 'Unknown equipment.'); };

  api.get('/issues', 'any', async (_req, res) => res.json({ issues: db.prepare('SELECT * FROM issues ORDER BY updated_at DESC LIMIT 1000').all() }));
  api.post('/issues', P('issues.write'), async (req, res) => {
    const b = parse(z.object({ id: id.optional(), kind: z.enum(['issue', 'lesson']), title: text(160, 1), body: text(4000).optional(), equipment_id: id.optional() }).strict(), req.body);
    eqOk(b.equipment_id);
    if (b.id && db.prepare('SELECT 1 FROM issues WHERE id=?').get(b.id)) throw new HttpError(409, 'ID_EXISTS', 'That id already exists.');
    const iid = b.id || crypto.randomUUID(), at = editTime(req);
    db.transaction(() => {
      db.prepare('INSERT INTO issues (id,kind,title,body,equipment_id,created_by,updated_by,created_at,updated_at,edit_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(iid, b.kind, b.title, b.body || '', b.equipment_id || null, req.user.id, req.user.id, now(), now(), at);
      audit(req, 'issue.create', 'issue', iid, { kind: b.kind });
    })();
    res.status(201).json({ issue: db.prepare('SELECT * FROM issues WHERE id=?').get(iid) });
  });
  // People may edit only their own entries unless their role can manage everyone's.
  api.patch('/issues/:id', P('issues.write'), async (req, res) => {
    const cur = db.prepare('SELECT * FROM issues WHERE id=?').get(parse(id, req.params.id));
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    if (cur.created_by !== req.user.id && !req.permissions.has('issues.manage')) throw new HttpError(403, 'FORBIDDEN', 'You can only edit your own entries.');
    const b = parse(z.object({ title: text(160, 1).optional(), body: text(4000).optional(), status: z.enum(['open', 'resolved']).optional() }).strict(), req.body);
    const at = editTime(req);
    if (superseded(cur.edit_at, at)) {
      db.transaction(() => audit(req, 'sync.superseded', 'issue', cur.id, { edit_time: at, current_edit_at: cur.edit_at }))();
      return res.json({ applied: false, superseded: true, issue: db.prepare('SELECT * FROM issues WHERE id=?').get(cur.id) });
    }
    db.transaction(() => {
      db.prepare('UPDATE issues SET title=?,body=?,status=?,version=version+1,updated_by=?,updated_at=?,edit_at=? WHERE id=?')
        .run(b.title ?? cur.title, b.body ?? cur.body, b.status ?? cur.status, req.user.id, now(), at, cur.id);
      audit(req, 'issue.update', 'issue', cur.id, { status: b.status });
    })();
    res.json({ issue: db.prepare('SELECT * FROM issues WHERE id=?').get(cur.id) });
  });

  // ---- update management: record + track only. Nothing here ever installs anything. ----
  api.get('/updates', 'any', async (_req, res) => res.json({ updates: db.prepare('SELECT u.* FROM equipment_updates u JOIN equipment e ON e.id=u.equipment_id AND e.deleted_at IS NULL ORDER BY u.created_at DESC LIMIT 1000').all() }));
  api.post('/updates', P('updates.record'), async (req, res) => {
    const b = parse(z.object({ id: id.optional(), equipment_id: id, kind: z.enum(['firmware', 'software', 'other']), available_version: text(60, 1), notes: text(2000).optional(), source_url: url.optional() }).strict(), req.body);
    eqOk(b.equipment_id);
    if (b.id && db.prepare('SELECT 1 FROM equipment_updates WHERE id=?').get(b.id)) throw new HttpError(409, 'ID_EXISTS', 'That id already exists.');
    const uid = b.id || crypto.randomUUID(), at = editTime(req);
    db.transaction(() => {
      db.prepare('INSERT INTO equipment_updates (id,equipment_id,kind,available_version,notes,source_url,created_by,created_at,edit_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uid, b.equipment_id, b.kind, b.available_version, b.notes || '', b.source_url || null, req.user.id, now(), at);
      audit(req, 'update.record', 'equipment_update', uid, { equipment_id: b.equipment_id, version: b.available_version });
    })();
    res.status(201).json({ id: uid });
  });
  api.patch('/updates/:id/status', P('updates.record'), async (req, res) => {
    const cur = db.prepare('SELECT * FROM equipment_updates WHERE id=?').get(parse(id, req.params.id));
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const b = parse(z.object({ status: z.enum(['available', 'scheduled', 'installed_by_human', 'skipped']) }).strict(), req.body);
    const at = editTime(req);
    if (superseded(cur.edit_at, at)) {
      db.transaction(() => audit(req, 'sync.superseded', 'equipment_update', cur.id, { edit_time: at, current_edit_at: cur.edit_at }))();
      return res.json({ ok: true, applied: false, superseded: true });
    }
    db.transaction(() => {
      db.prepare('UPDATE equipment_updates SET status=?,status_by=?,status_at=?,edit_at=? WHERE id=?').run(b.status, req.user.id, now(), at, cur.id);
      audit(req, 'update.status', 'equipment_update', cur.id, { from: cur.status, to: b.status });
    })();
    res.json({ ok: true });
  });
};
