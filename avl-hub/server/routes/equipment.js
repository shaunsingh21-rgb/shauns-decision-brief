'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, slug, url, PROVENANCE, parse, hostMatches } = require('../lib/validate');
const { editTime, superseded } = require('../lib/sync');

const EDITORS = ['admin', 'trainer', 'technician'];
const ADMIN = ['admin'];

const field = z.object({
  key: slug,
  value: text(2000).default(''),
  provenance: z.enum(PROVENANCE),
  source_url: url.optional(),
}).strict();

module.exports = function equipmentRoutes(api, ctx) {
  const { db, audit } = ctx;
  const now = () => new Date().toISOString();
  const domains = () => db.prepare('SELECT domain FROM source_domains').all().map(r => r.domain);

  // Provenance rules: never guess. VERIFY == empty value. Manufacturer claims need an admin-listed official source.
  function checkField(f) {
    if (f.provenance === 'verify' && f.value !== '') throw new HttpError(400, 'VERIFY_MUST_BE_EMPTY', `Field "${f.key}" is marked VERIFY, so it must have no value.`);
    if (f.provenance !== 'verify' && f.value === '') throw new HttpError(400, 'VALUE_REQUIRED', `Field "${f.key}" needs a value, or mark it VERIFY.`);
    if (f.provenance === 'manufacturer') {
      if (!f.source_url) throw new HttpError(400, 'SOURCE_REQUIRED', `Field "${f.key}" is marked manufacturer, so it needs a source URL.`);
      if (!hostMatches(f.source_url, domains()))
        throw new HttpError(400, 'SOURCE_NOT_OFFICIAL', `Field "${f.key}": that site is not on the admin-listed official domains.`);
    }
  }
  const upsertField = (eid, f, uid) => db.prepare(`
    INSERT INTO equipment_fields (equipment_id,key,value,provenance,source_url,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(equipment_id,key) DO UPDATE SET value=excluded.value, provenance=excluded.provenance, source_url=excluded.source_url,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(eid, f.key, f.value, f.provenance, f.source_url || null, uid, now());

  const live = eid => {
    const e = db.prepare('SELECT * FROM equipment WHERE id=? AND deleted_at IS NULL').get(eid);
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Equipment not found.');
    return e;
  };
  const full = eid => {
    const e = live(eid);
    e.fields = db.prepare('SELECT key,value,provenance,source_url,updated_at FROM equipment_fields WHERE equipment_id=? ORDER BY key').all(eid);
    e.verify_keys = e.fields.filter(f => f.provenance === 'verify').map(f => f.key);
    e.approvals = db.prepare('SELECT approved_by,override,override_reason,verify_keys,created_at FROM equipment_approvals WHERE equipment_id=? ORDER BY rowid DESC LIMIT 10').all(eid);
    return e;
  };

  api.get('/equipment', 'any', async (_req, res) => res.json({ equipment: db.prepare(
    `SELECT e.id,e.name,e.manufacturer,e.category,e.status,e.version,e.updated_at,
       (SELECT COUNT(*) FROM equipment_fields f WHERE f.equipment_id=e.id AND f.provenance='verify') AS verify_count
     FROM equipment e WHERE deleted_at IS NULL ORDER BY e.name`).all() }));
  api.get('/equipment/:id', 'any', async (req, res) => res.json({ equipment: full(parse(id, req.params.id)) }));

  api.post('/equipment', EDITORS, async (req, res) => {
    const b = parse(z.object({ id: id.optional(), name: text(120, 1), manufacturer: text(120).optional(), category: text(60).optional(), fields: z.array(field).max(100).default([]) }).strict(), req.body);
    if (b.id && db.prepare('SELECT 1 FROM equipment WHERE id=?').get(b.id)) throw new HttpError(409, 'ID_EXISTS', 'That id already exists.');
    b.fields.forEach(checkField);
    if (new Set(b.fields.map(f => f.key)).size !== b.fields.length) throw new HttpError(400, 'DUPLICATE_FIELD', 'Duplicate field keys.');
    const eid = b.id || crypto.randomUUID(), at = editTime(req);
    db.transaction(() => {
      db.prepare(`INSERT INTO equipment (id,name,manufacturer,category,status,created_by,updated_by,created_at,updated_at,edit_at) VALUES (?,?,?,?, 'draft',?,?,?,?,?)`)
        .run(eid, b.name, b.manufacturer || null, b.category || null, req.user.id, req.user.id, now(), now(), at);
      b.fields.forEach(f => upsertField(eid, f, req.user.id));
      audit(req, 'equipment.create', 'equipment', eid, { name: b.name, fields: b.fields.map(f => `${f.key}:${f.provenance}`) });
    })();
    res.status(201).json({ equipment: full(eid) });
  });

  api.patch('/equipment/:id', EDITORS, async (req, res) => {
    const eid = parse(id, req.params.id);
    const b = parse(z.object({ name: text(120, 1).optional(), manufacturer: text(120).optional(), category: text(60).optional(),
      fields: z.array(field).max(100).optional(), remove_fields: z.array(slug).max(100).optional() }).strict(), req.body);
    const cur = live(eid);
    (b.fields || []).forEach(checkField);
    const at = editTime(req);
    // Last-writer-wins per record: if someone edited this record LATER than this edit was made, keep theirs and say so.
    if (superseded(cur.edit_at, at)) {
      db.transaction(() => audit(req, 'sync.superseded', 'equipment', eid, { edit_time: at, current_edit_at: cur.edit_at }))();
      return res.json({ applied: false, superseded: true, equipment: full(eid) });
    }
    // Editing approved material returns it to Needs Review.
    const status = cur.status === 'approved' ? 'needs_review' : cur.status;
    db.transaction(() => {
      db.prepare('UPDATE equipment SET name=?,manufacturer=?,category=?,status=?,version=version+1,updated_by=?,updated_at=?,edit_at=? WHERE id=?')
        .run(b.name ?? cur.name, b.manufacturer ?? cur.manufacturer, b.category ?? cur.category, status, req.user.id, now(), at, eid);
      (b.fields || []).forEach(f => upsertField(eid, f, req.user.id));
      (b.remove_fields || []).forEach(k => db.prepare('DELETE FROM equipment_fields WHERE equipment_id=? AND key=?').run(eid, k));
      audit(req, 'equipment.update', 'equipment', eid, { status_change: status !== cur.status ? `${cur.status}->${status}` : undefined,
        fields: (b.fields || []).map(f => `${f.key}:${f.provenance}`), removed: b.remove_fields });
    })();
    res.json({ equipment: full(eid) });
  });

  api.post('/equipment/:id/submit-review', EDITORS, async (req, res) => {
    const eid = parse(id, req.params.id); const cur = live(eid);
    if (cur.status === 'approved') throw new HttpError(409, 'ALREADY_APPROVED', 'Already approved.');
    db.transaction(() => {
      db.prepare("UPDATE equipment SET status='needs_review', version=version+1, updated_by=?, updated_at=? WHERE id=?").run(req.user.id, now(), eid);
      audit(req, 'equipment.submit_review', 'equipment', eid);
    })();
    res.json({ equipment: full(eid) });
  });

  // Approval is a human, attributed, append-only act. VERIFY items block it unless explicitly overridden with a reason.
  api.post('/equipment/:id/approve', ADMIN, async (req, res) => {
    const eid = parse(id, req.params.id);
    const b = parse(z.object({ override: z.boolean().default(false), override_reason: text(500).optional(), reviewed_version: z.number().int().optional() }).strict(), req.body);
    const cur = live(eid);
    // An approval applies to the version the approver actually reviewed (matters for approvals made offline and synced later).
    if (b.reviewed_version !== undefined && b.reviewed_version !== cur.version) throw new HttpError(409, 'STALE_REVIEW', 'This record changed after you reviewed it. Review the latest version, then approve again.', { current_version: cur.version });
    if (cur.status === 'approved') throw new HttpError(409, 'ALREADY_APPROVED', 'Already approved.');
    const verify = db.prepare("SELECT key FROM equipment_fields WHERE equipment_id=? AND provenance='verify'").all(eid).map(r => r.key);
    if (verify.length && !b.override)
      throw new HttpError(409, 'VERIFY_ITEMS_REMAIN', 'This record still has VERIFY items. Resolve them, or approve with an explicit override and a reason.', { verify_keys: verify });
    if (verify.length && (b.override_reason || '').length < 5)
      throw new HttpError(400, 'OVERRIDE_REASON_REQUIRED', 'An override needs a reason (at least 5 characters).');
    db.transaction(() => {
      db.prepare("UPDATE equipment SET status='approved', version=version+1, updated_by=?, updated_at=? WHERE id=?").run(req.user.id, now(), eid);
      db.prepare('INSERT INTO equipment_approvals VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(), eid, req.user.id,
        verify.length ? 1 : 0, verify.length ? b.override_reason : null, JSON.stringify(verify), now());
      audit(req, verify.length ? 'equipment.approve_override' : 'equipment.approve', 'equipment', eid, { verify_keys: verify, reason: b.override_reason });
    })();
    res.json({ equipment: full(eid) });
  });

  api.delete('/equipment/:id', ADMIN, async (req, res) => {
    const eid = parse(id, req.params.id); live(eid);
    db.transaction(() => {
      db.prepare('UPDATE equipment SET deleted_at=?, updated_by=?, updated_at=? WHERE id=?').run(now(), req.user.id, now(), eid);
      audit(req, 'equipment.delete', 'equipment', eid);
    })();
    res.json({ ok: true });
  });
};
