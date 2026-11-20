'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, url, parse, hostMatches } = require('../lib/validate');


// Installation assistant: an ordered checklist per equipment item. Steps are never invented by the server.
module.exports = function installRoutes(api, ctx) {
  const { P } = api;
  const { db, audit } = ctx;
  const now = () => new Date().toISOString();
  const live = eid => { const e = db.prepare('SELECT * FROM equipment WHERE id=? AND deleted_at IS NULL').get(eid); if (!e) throw new HttpError(404, 'NOT_FOUND', 'Equipment not found.'); return e; };
  const steps = eid => db.prepare('SELECT id,position,text,provenance,source_url FROM install_steps WHERE equipment_id=? ORDER BY position').all(eid);

  api.get('/equipment/:id/install-steps', 'any', async (req, res) => {
    const eid = parse(id, req.params.id); live(eid);
    res.json({ steps: steps(eid), done: db.prepare('SELECT step_id FROM install_progress WHERE user_id=? AND step_id IN (SELECT id FROM install_steps WHERE equipment_id=?)').all(req.user.id, eid).map(r => r.step_id) });
  });

  api.put('/equipment/:id/install-steps', P('equipment.edit'), async (req, res) => {
    const eid = parse(id, req.params.id); const e = live(eid);
    const b = parse(z.object({ steps: z.array(z.object({ text: text(600, 1), provenance: z.enum(['manufacturer', 'team', 'ai']), source_url: url.optional() }).strict()).max(60) }).strict(), req.body);
    const domains = db.prepare('SELECT domain FROM source_domains').all().map(r => r.domain);
    for (const s of b.steps) if (s.provenance === 'manufacturer' && (!s.source_url || !hostMatches(s.source_url, domains)))
      throw new HttpError(400, 'SOURCE_NOT_OFFICIAL', 'Manufacturer steps need a source URL on an admin-listed official domain.');
    db.transaction(() => {
      db.prepare('DELETE FROM install_steps WHERE equipment_id=?').run(eid);
      b.steps.forEach((s, i) => db.prepare('INSERT INTO install_steps VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), eid, i, s.text, s.provenance, s.source_url || null));
      if (e.status === 'approved') db.prepare("UPDATE equipment SET status='needs_review',version=version+1,updated_by=?,updated_at=? WHERE id=?").run(req.user.id, now(), eid);
      audit(req, 'install_steps.replace', 'equipment', eid, { count: b.steps.length, status_change: e.status === 'approved' ? 'approved->needs_review' : undefined });
    })();
    res.json({ steps: steps(eid) });
  });

  api.put('/equipment/:id/install-progress', P('equipment.edit'), async (req, res) => {
    const eid = parse(id, req.params.id); live(eid);
    const b = parse(z.object({ done: z.array(id).max(60) }).strict(), req.body);
    const valid = new Set(steps(eid).map(s => s.id));
    db.transaction(() => {
      db.prepare('DELETE FROM install_progress WHERE user_id=? AND step_id IN (SELECT id FROM install_steps WHERE equipment_id=?)').run(req.user.id, eid);
      for (const sid of new Set(b.done)) if (valid.has(sid)) db.prepare('INSERT INTO install_progress VALUES (?,?,?)').run(req.user.id, sid, now());
    })();
    res.json({ ok: true });
  });
};
