'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, url, PROVENANCE, parse, hostMatches } = require('../lib/validate');
const { editTime, superseded } = require('../lib/sync');

const EDITORS = ['admin', 'trainer', 'technician'];

const pin = z.object({ id: id.optional(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), label: text(120).default(''), note: text(1000).default(''),
  provenance: z.enum(PROVENANCE), source_url: url.optional() }).strict();

module.exports = function panelRoutes(api, ctx) {
  const { db, audit } = ctx;
  const now = () => new Date().toISOString();
  const domains = () => db.prepare('SELECT domain FROM source_domains').all().map(r => r.domain);
  const panel = pid => { const p = db.prepare('SELECT * FROM photo_panels WHERE id=? AND deleted_at IS NULL').get(pid); if (!p) throw new HttpError(404, 'NOT_FOUND', 'Panel not found.'); return p; };
  const full = pid => { const p = panel(pid); p.pins = db.prepare('SELECT id,x,y,label,note,provenance,source_url FROM panel_pins WHERE panel_id=? ORDER BY rowid').all(pid);
    p.verify_count = p.pins.filter(x => x.provenance === 'verify').length; return p; };
  // Same "never guess" rules as equipment fields; every pin carries its source.
  function checkPin(p) {
    if (p.provenance === 'verify' && p.label !== '') throw new HttpError(400, 'VERIFY_MUST_BE_EMPTY', 'A pin marked VERIFY must have no label (it is not identified yet).');
    if (p.provenance !== 'verify' && p.label === '') throw new HttpError(400, 'LABEL_REQUIRED', 'Give the pin a label, or mark it VERIFY.');
    if (p.provenance === 'manufacturer') {
      if (!p.source_url) throw new HttpError(400, 'SOURCE_REQUIRED', 'A Manufacturer pin needs a source URL.');
      if (!hostMatches(p.source_url, domains())) throw new HttpError(400, 'SOURCE_NOT_OFFICIAL', 'That site is not on the admin-listed official domains.');
    }
  }
  // Editing approved material returns it to Needs Review.
  const touch = (req, pid) => db.prepare(`UPDATE photo_panels SET status=CASE WHEN status='approved' THEN 'needs_review' ELSE status END, version=version+1, updated_by=?, updated_at=? WHERE id=?`).run(req.user.id, now(), pid);

  api.get('/panels', 'any', async (req, res) => {
    const q = parse(z.object({ equipment_id: id.optional() }), req.query);
    res.json({ panels: db.prepare(`SELECT p.id,p.equipment_id,p.title,p.file_id,p.status,p.updated_at,(SELECT COUNT(*) FROM panel_pins x WHERE x.panel_id=p.id) pins
      FROM photo_panels p WHERE p.deleted_at IS NULL AND (? IS NULL OR p.equipment_id=?) ORDER BY p.title`).all(q.equipment_id || null, q.equipment_id || null) });
  });
  api.get('/panels/:id', 'any', async (req, res) => res.json({ panel: full(parse(id, req.params.id)) }));

  api.post('/panels', EDITORS, async (req, res) => {
    const b = parse(z.object({ equipment_id: id, title: text(120, 1), file_id: id }).strict(), req.body);
    if (!db.prepare('SELECT 1 FROM equipment WHERE id=? AND deleted_at IS NULL').get(b.equipment_id)) throw new HttpError(400, 'BAD_EQUIPMENT', 'Unknown equipment.');
    if (!db.prepare("SELECT 1 FROM files WHERE id=? AND purpose='photo' AND deleted_at IS NULL").get(b.file_id)) throw new HttpError(400, 'BAD_FILE', 'Choose an uploaded photo.');
    const pid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO photo_panels (id,equipment_id,title,file_id,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(pid, b.equipment_id, b.title, b.file_id, req.user.id, req.user.id, now(), now());
      audit(req, 'panel.create', 'panel', pid, { equipment_id: b.equipment_id });
    })();
    res.status(201).json({ panel: full(pid) });
  });

  api.patch('/panels/:id', EDITORS, async (req, res) => {
    const p = panel(parse(id, req.params.id)); const b = parse(z.object({ title: text(120, 1) }).strict(), req.body);
    db.transaction(() => { db.prepare('UPDATE photo_panels SET title=? WHERE id=?').run(b.title, p.id); touch(req, p.id); audit(req, 'panel.update', 'panel', p.id); })();
    res.json({ panel: full(p.id) });
  });

  api.post('/panels/:id/pins', EDITORS, async (req, res) => {
    const p = panel(parse(id, req.params.id)); const b = parse(pin, req.body); checkPin(b);
    if (b.id && db.prepare('SELECT 1 FROM panel_pins WHERE id=?').get(b.id)) throw new HttpError(409, 'ID_EXISTS', 'That id already exists.');
    const xid = b.id || crypto.randomUUID(), at = editTime(req);
    db.transaction(() => {
      db.prepare('INSERT INTO panel_pins (id,panel_id,x,y,label,note,provenance,source_url,created_by,created_at,edit_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(xid, p.id, b.x, b.y, b.label, b.note, b.provenance, b.source_url || null, req.user.id, now(), at);
      touch(req, p.id); audit(req, 'pin.add', 'panel', p.id, { pin_id: xid, provenance: b.provenance });
    })();
    res.status(201).json({ panel: full(p.id) });
  });
  api.patch('/pins/:id', EDITORS, async (req, res) => {
    const cur = db.prepare('SELECT * FROM panel_pins WHERE id=?').get(parse(id, req.params.id));
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Pin not found.');
    const b = parse(pin, req.body); checkPin(b);
    const at = editTime(req);
    if (superseded(cur.edit_at, at)) {
      db.transaction(() => audit(req, 'sync.superseded', 'panel', cur.panel_id, { pin_id: cur.id, edit_time: at, current_edit_at: cur.edit_at }))();
      return res.json({ applied: false, superseded: true, panel: full(cur.panel_id) });
    }
    db.transaction(() => {
      db.prepare('UPDATE panel_pins SET x=?,y=?,label=?,note=?,provenance=?,source_url=?,edit_at=? WHERE id=?').run(b.x, b.y, b.label, b.note, b.provenance, b.source_url || null, at, cur.id);
      touch(req, cur.panel_id); audit(req, 'pin.update', 'panel', cur.panel_id, { pin_id: cur.id, provenance: b.provenance });
    })();
    res.json({ panel: full(cur.panel_id) });
  });
  api.delete('/pins/:id', EDITORS, async (req, res) => {
    const cur = db.prepare('SELECT * FROM panel_pins WHERE id=?').get(parse(id, req.params.id));
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Pin not found.');
    db.transaction(() => { db.prepare('DELETE FROM panel_pins WHERE id=?').run(cur.id); touch(req, cur.panel_id); audit(req, 'pin.remove', 'panel', cur.panel_id, { pin_id: cur.id }); })();
    res.json({ panel: full(cur.panel_id) });
  });

  api.post('/panels/:id/submit-review', EDITORS, async (req, res) => {
    const p = panel(parse(id, req.params.id));
    if (p.status === 'approved') throw new HttpError(409, 'ALREADY_APPROVED', 'Already approved.');
    db.transaction(() => { db.prepare("UPDATE photo_panels SET status='needs_review',version=version+1,updated_by=?,updated_at=? WHERE id=?").run(req.user.id, now(), p.id); audit(req, 'panel.submit_review', 'panel', p.id); })();
    res.json({ panel: full(p.id) });
  });
  api.post('/panels/:id/approve', ['admin'], async (req, res) => {
    const p = panel(parse(id, req.params.id));
    const b = parse(z.object({ override: z.boolean().default(false), override_reason: text(500).optional(), reviewed_version: z.number().int().optional() }).strict(), req.body);
    if (b.reviewed_version !== undefined && b.reviewed_version !== p.version) throw new HttpError(409, 'STALE_REVIEW', 'This panel changed after you reviewed it. Review the latest version, then approve again.', { current_version: p.version });
    if (p.status === 'approved') throw new HttpError(409, 'ALREADY_APPROVED', 'Already approved.');
    const verify = db.prepare("SELECT COUNT(*) n FROM panel_pins WHERE panel_id=? AND provenance='verify'").get(p.id).n;
    if (verify && !b.override) throw new HttpError(409, 'VERIFY_ITEMS_REMAIN', 'This panel still has VERIFY pins. Resolve them, or approve with an explicit override and a reason.', { verify_count: verify });
    if (verify && (b.override_reason || '').length < 5) throw new HttpError(400, 'OVERRIDE_REASON_REQUIRED', 'An override needs a reason (at least 5 characters).');
    db.transaction(() => {
      db.prepare("UPDATE photo_panels SET status='approved',version=version+1,updated_by=?,updated_at=? WHERE id=?").run(req.user.id, now(), p.id);
      db.prepare('INSERT INTO panel_approvals VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), p.id, req.user.id, verify ? 1 : 0, verify ? b.override_reason : null, now());
      audit(req, verify ? 'panel.approve_override' : 'panel.approve', 'panel', p.id, { verify_pins: verify, reason: b.override_reason });
    })();
    res.json({ panel: full(p.id) });
  });
  api.delete('/panels/:id', ['admin'], async (req, res) => {
    const p = panel(parse(id, req.params.id));
    db.transaction(() => {
      db.prepare('UPDATE photo_panels SET deleted_at=?,updated_by=?,updated_at=? WHERE id=?').run(now(), req.user.id, now(), p.id);
      audit(req, 'panel.delete', 'panel', p.id);
    })();
    res.json({ ok: true });
  });
};
