'use strict';
// Content export / import. Import ADDS what is missing and NEVER overwrites or deletes: sign-offs, approvals and scores are
// append-only history that points at this content, so replacing it would break that history. Accounts and credentials are never exported.
const crypto = require('crypto');
const { z, text, id, slug, url, domain, PROVENANCE, hostMatches, httpsUrl, sharepointUrl } = require('./validate');
const { HttpError } = require('./errors');

const FORMAT = 'avl-hub-content', VERSION = 1;

function buildExport(db) {
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const equipment = all('SELECT id,name,manufacturer,category FROM equipment WHERE deleted_at IS NULL ORDER BY name').map(e => ({
    ...e,
    fields: all('SELECT key,value,provenance,source_url FROM equipment_fields WHERE equipment_id=? ORDER BY key', e.id),
    install_steps: all('SELECT text,provenance,source_url FROM install_steps WHERE equipment_id=? ORDER BY position', e.id),
  }));
  const liveEq = new Set(equipment.map(e => e.id));
  const modules = all('SELECT id,title,level,summary,equipment_id FROM training_modules ORDER BY level,title').map(m => ({
    ...m, equipment_id: liveEq.has(m.equipment_id) ? m.equipment_id : null,
    questions: all('SELECT id,prompt,options,correct_index FROM quiz_questions WHERE module_id=? ORDER BY rowid', m.id).map(q => ({ ...q, options: JSON.parse(q.options) })),
    skills: all('SELECT id,name FROM practical_skills WHERE module_id=? ORDER BY rowid', m.id),
    videos: all("SELECT id,title,kind,url FROM lesson_videos WHERE module_id=? AND kind<>'upload' ORDER BY position,rowid", m.id).map(v => ({
      ...v, checkpoints: all('SELECT id,at_seconds,prompt,options,correct_index FROM video_checkpoints WHERE video_id=? ORDER BY at_seconds', v.id).map(c => ({ ...c, options: JSON.parse(c.options) })) })),
  }));
  return {
    format: FORMAT, version: VERSION, exported_at: new Date().toISOString(),
    note: 'Content only. No accounts, passwords, sign-offs, approvals, quiz results, photos or uploaded files.',
    source_domains: all('SELECT domain FROM source_domains ORDER BY domain').map(r => r.domain),
    equipment, modules,
    issues: all('SELECT id,kind,title,body,equipment_id,status FROM issues ORDER BY created_at').map(i => ({ ...i, equipment_id: liveEq.has(i.equipment_id) ? i.equipment_id : null })),
    updates: all('SELECT id,equipment_id,kind,available_version,notes,source_url FROM equipment_updates ORDER BY created_at').filter(u => liveEq.has(u.equipment_id)),
    panels: all('SELECT id,equipment_id,title,file_id FROM photo_panels WHERE deleted_at IS NULL ORDER BY title').filter(p => liveEq.has(p.equipment_id)).map(p => ({
      ...p, pins: all('SELECT id,x,y,label,note,provenance,source_url FROM panel_pins WHERE panel_id=? ORDER BY rowid', p.id) })),
  };
}

const field = z.object({ key: slug, value: text(2000).default(''), provenance: z.enum(PROVENANCE), source_url: url.nullish().transform(v => v || undefined) }).strict();
const step = z.object({ text: text(600, 1), provenance: z.enum(['manufacturer', 'team', 'ai']), source_url: url.nullish().transform(v => v || undefined) }).strict();
const opts = z.array(text(200, 1)).min(2).max(6);
const Schema = z.object({
  format: z.literal(FORMAT), version: z.literal(VERSION), exported_at: z.string().max(40).optional(), note: z.string().max(500).optional(),
  source_domains: z.array(domain).max(200),
  equipment: z.array(z.object({ id, name: text(120, 1), manufacturer: text(120).nullish(), category: text(60).nullish(), fields: z.array(field).max(100), install_steps: z.array(step).max(60) }).strict()).max(2000),
  modules: z.array(z.object({ id, title: text(120, 1), level: z.number().int().min(1).max(5), summary: text(2000).default(''), equipment_id: id.nullish(),
    questions: z.array(z.object({ id, prompt: text(500, 1), options: opts, correct_index: z.number().int().min(0) }).strict()).max(200),
    skills: z.array(z.object({ id, name: text(120, 1) }).strict()).max(100),
    videos: z.array(z.object({ id, title: text(160, 1), kind: z.enum(['sharepoint_embed', 'link']), url: z.string().max(2048),
      checkpoints: z.array(z.object({ id, at_seconds: z.number().int().min(0).max(86400), prompt: text(300, 1), options: opts, correct_index: z.number().int().min(0) }).strict()).max(100) }).strict()).max(50),
  }).strict()).max(1000),
  issues: z.array(z.object({ id, kind: z.enum(['issue', 'lesson']), title: text(160, 1), body: text(4000).default(''), equipment_id: id.nullish(), status: z.enum(['open', 'resolved']) }).strict()).max(5000),
  updates: z.array(z.object({ id, equipment_id: id, kind: z.enum(['firmware', 'software', 'other']), available_version: text(60, 1), notes: text(2000).default(''), source_url: url.nullish().transform(v => v || undefined) }).strict()).max(5000),
  panels: z.array(z.object({ id, equipment_id: id, title: text(120, 1), file_id: id, pins: z.array(z.object({ id, x: z.number().min(0).max(1), y: z.number().min(0).max(1), label: text(120).default(''), note: text(1000).default(''), provenance: z.enum(PROVENANCE), source_url: url.nullish().transform(v => v || undefined) }).strict()).max(200) }).strict()).max(2000),
}).strict();

function validate(data) {
  const r = Schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'IMPORT_INVALID', 'This file is not a valid AVL Hub export. Nothing was imported.',
    { details: r.error.issues.slice(0, 20).map(i => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

// All-or-nothing. With dryRun the same checks run and the transaction is rolled back.
function importContent(db, rawData, { actor, config, dryRun = false }) {
  const d = validate(rawData);
  const now = new Date().toISOString(), added = {}, skipped = {}, warnings = [];
  const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
  const has = (table, i) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(i);
  const bad = msg => { throw new HttpError(400, 'IMPORT_INVALID', `${msg} Nothing was imported.`); };
  class Rollback extends Error {}

  const run = db.transaction(() => {
    for (const dom of d.source_domains) { if (db.prepare('SELECT 1 FROM source_domains WHERE domain=?').get(dom)) bump(skipped, 'source_domains'); else { db.prepare('INSERT INTO source_domains VALUES (?,?,?)').run(dom, actor.id, now); bump(added, 'source_domains'); } }
    const domains = db.prepare('SELECT domain FROM source_domains').all().map(r => r.domain);
    // The same "never guess" provenance rules as everywhere else in the app.
    const checkSrc = (what, prov, value, src) => {
      if (value !== undefined) { if (prov === 'verify' && value !== '') bad(`${what}: marked VERIFY but has a value.`); if (prov !== 'verify' && value === '') bad(`${what}: needs a value or must be marked VERIFY.`); }
      if (prov === 'manufacturer' && (!src || !hostMatches(src, domains))) bad(`${what}: Manufacturer source is missing or not on an official domain.`);
    };
    const eqIds = new Set(db.prepare('SELECT id FROM equipment').all().map(r => r.id));
    for (const e of d.equipment) {
      if (eqIds.has(e.id)) { bump(skipped, 'equipment'); continue; }
      e.fields.forEach(f => checkSrc(`Equipment "${e.name}" item ${f.key}`, f.provenance, f.value, f.source_url));
      e.install_steps.forEach((s, i) => checkSrc(`Equipment "${e.name}" step ${i + 1}`, s.provenance, undefined, s.source_url));
      if (new Set(e.fields.map(f => f.key)).size !== e.fields.length) bad(`Equipment "${e.name}" has duplicate items.`);
      db.prepare("INSERT INTO equipment (id,name,manufacturer,category,status,created_by,updated_by,created_at,updated_at,edit_at) VALUES (?,?,?,?,'draft',?,?,?,?,?)").run(e.id, e.name, e.manufacturer || null, e.category || null, actor.id, actor.id, now, now, now);   // never imported as Approved
      for (const f of e.fields) db.prepare('INSERT INTO equipment_fields VALUES (?,?,?,?,?,?,?)').run(e.id, f.key, f.value, f.provenance, f.source_url || null, actor.id, now);
      e.install_steps.forEach((s, i) => db.prepare('INSERT INTO install_steps VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), e.id, i, s.text, s.provenance, s.source_url || null));
      eqIds.add(e.id); bump(added, 'equipment');
    }
    const needEq = (what, eid) => { if (eid && !eqIds.has(eid)) bad(`${what} refers to equipment that does not exist (${eid}).`); };
    for (const m of d.modules) {
      if (has('training_modules', m.id)) { bump(skipped, 'modules'); continue; }
      needEq(`Module "${m.title}"`, m.equipment_id);
      for (const q of m.questions) if (q.correct_index >= q.options.length) bad(`Module "${m.title}": a question's correct answer is out of range.`);
      for (const v of m.videos) {
        if (!(v.kind === 'sharepoint_embed' ? sharepointUrl(v.url, config.sharepointHosts) : httpsUrl(v.url))) bad(`Module "${m.title}": video "${v.title}" has a link that is not allowed.`);
        for (const c of v.checkpoints) if (c.correct_index >= c.options.length) bad(`Module "${m.title}": a checkpoint's correct answer is out of range.`);
      }
      db.prepare("INSERT INTO training_modules (id,title,level,equipment_id,summary,status,created_by,updated_by,created_at,updated_at,edit_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)").run(m.id, m.title, m.level, m.equipment_id || null, m.summary, actor.id, actor.id, now, now, now);
      for (const q of m.questions) db.prepare('INSERT INTO quiz_questions VALUES (?,?,?,?,?)').run(q.id, m.id, q.prompt, JSON.stringify(q.options), q.correct_index);
      for (const s of m.skills) db.prepare('INSERT INTO practical_skills VALUES (?,?,?)').run(s.id, m.id, s.name);
      m.videos.forEach((v, i) => { db.prepare('INSERT INTO lesson_videos VALUES (?,?,?,?,?,NULL,?,?,?)').run(v.id, m.id, v.title, v.kind, v.url, i, actor.id, now);
        for (const c of v.checkpoints) db.prepare('INSERT INTO video_checkpoints VALUES (?,?,?,?,?,?)').run(c.id, v.id, c.at_seconds, c.prompt, JSON.stringify(c.options), c.correct_index); });
      bump(added, 'modules');
    }
    for (const i of d.issues) {
      if (has('issues', i.id)) { bump(skipped, 'issues'); continue; }
      needEq(`Issue "${i.title}"`, i.equipment_id);
      db.prepare('INSERT INTO issues (id,kind,title,body,equipment_id,status,created_by,updated_by,created_at,updated_at,edit_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(i.id, i.kind, i.title, i.body, i.equipment_id || null, i.status, actor.id, actor.id, now, now, now); bump(added, 'issues');
    }
    for (const u of d.updates) {
      if (has('equipment_updates', u.id)) { bump(skipped, 'updates'); continue; }
      needEq('An update record', u.equipment_id);
      db.prepare("INSERT INTO equipment_updates (id,equipment_id,kind,available_version,notes,source_url,status,created_by,created_at,edit_at) VALUES (?,?,?,?,?,?,'available',?,?,?)").run(u.id, u.equipment_id, u.kind, u.available_version, u.notes, u.source_url || null, actor.id, now, now); bump(added, 'updates');   // never imported as "installed"
    }
    for (const p of d.panels) {
      if (has('photo_panels', p.id)) { bump(skipped, 'panels'); continue; }
      needEq(`Panel "${p.title}"`, p.equipment_id);
      for (const x of p.pins) {                                   // the whole file is validated, even for panels that end up skipped below
        if (x.provenance === 'verify' && x.label !== '') bad(`Panel "${p.title}": a VERIFY pin has a label.`);
        if (x.provenance !== 'verify' && x.label === '') bad(`Panel "${p.title}": a pin has no label.`);
        if (x.provenance === 'manufacturer' && (!x.source_url || !hostMatches(x.source_url, domains))) bad(`Panel "${p.title}": a Manufacturer pin has no official source.`);
      }
      if (!db.prepare("SELECT 1 FROM files WHERE id=? AND purpose='photo' AND deleted_at IS NULL").get(p.file_id)) { warnings.push(`Panel "${p.title}" was skipped: its photo is not stored on this server (photos are not part of the export).`); bump(skipped, 'panels'); continue; }
      db.prepare("INSERT INTO photo_panels (id,equipment_id,title,file_id,status,created_by,updated_by,created_at,updated_at,edit_at) VALUES (?,?,?,?,'draft',?,?,?,?,?)").run(p.id, p.equipment_id, p.title, p.file_id, actor.id, actor.id, now, now, now);
      for (const x of p.pins) db.prepare('INSERT INTO panel_pins (id,panel_id,x,y,label,note,provenance,source_url,created_by,created_at,edit_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(x.id, p.id, x.x, x.y, x.label, x.note, x.provenance, x.source_url || null, actor.id, now, now);
      bump(added, 'panels');
    }
    // Safety net: whatever happened above, the system must still have an active administrator.
    if (db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get().n < 1) throw new HttpError(409, 'NO_ADMIN', 'The import was cancelled: it would leave the system without an active administrator.');
    if (dryRun) throw new Rollback();
  });
  try { run(); } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return { dry_run: dryRun, added, skipped, warnings, note: 'Imported items arrive as Draft and must be reviewed and approved. Nothing existing was changed or removed.' };
}
module.exports = { buildExport, importContent, FORMAT, VERSION };
