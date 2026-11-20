'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { harness } = require('../helpers');
const { importContent } = require('../../server/lib/portability');

let A, B, aAdmin, bAdmin, bTech, exp;
const count = (h, t) => h.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const TABLES = ['equipment', 'equipment_fields', 'install_steps', 'training_modules', 'quiz_questions', 'practical_skills', 'lesson_videos', 'video_checkpoints', 'issues', 'equipment_updates', 'photo_panels', 'panel_pins', 'source_domains'];
const snapshot = h => Object.fromEntries(TABLES.map(t => [t, count(h, t)]));
const clone = x => JSON.parse(JSON.stringify(x));
const fld = (d, k) => d.equipment[0].fields.find(f => f.key === k);

before(async () => {
  A = await harness(); B = await harness();
  aAdmin = await A.as(await A.makeUser('admin', 'adminA')); bAdmin = await B.as(await B.makeUser('admin', 'adminB')); bTech = await B.as(await B.makeUser('technician', 'techB'));
  await aAdmin.post('/api/sources', { domain: 'example-maker.com' });
  const tc = await A.as(await A.makeUser('trainer', 'trainerA')), kc = await A.as(await A.makeUser('technician', 'techA'));
  const e = (await kc.post('/api/equipment', { name: 'SAMPLE Mixer', manufacturer: 'SAMPLE Co', category: 'Audio', fields: [
    { key: 'rack', provenance: 'manufacturer', value: 'SAMPLE 2U', source_url: 'https://support.example-maker.com/mixer' }, { key: 'power', provenance: 'verify' }, { key: 'note', provenance: 'ai', value: 'SAMPLE AI text' }] })).body.equipment;
  await kc.put(`/api/equipment/${e.id}/install-steps`, { steps: [{ text: 'SAMPLE step', provenance: 'team' }, { text: 'SAMPLE vendor step', provenance: 'manufacturer', source_url: 'https://support.example-maker.com/steps' }] });
  await aAdmin.post(`/api/equipment/${e.id}/approve`, { override: true, override_reason: 'SAMPLE: pending' });                      // approved in A …
  const m = (await tc.post('/api/modules', { title: 'SAMPLE module', level: 2, equipment_id: e.id })).body.module;
  const q = await tc.post(`/api/modules/${m.id}/questions`, { prompt: 'SAMPLE q', options: ['a', 'b'], correct_index: 1 }); await tc.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE skill' });
  const v = (await tc.post(`/api/modules/${m.id}/videos`, { title: 'SAMPLE video', kind: 'sharepoint_embed', url: 'https://sample.sharepoint.com/embed' })).body.id;
  await tc.post(`/api/videos/${v}/checkpoints`, { at_seconds: 10, prompt: 'SAMPLE cp', options: ['x', 'y'], correct_index: 0 });
  await kc.post('/api/issues', { kind: 'lesson', title: 'SAMPLE lesson', equipment_id: e.id });
  const u = (await kc.post('/api/updates', { equipment_id: e.id, kind: 'firmware', available_version: 'SAMPLE-v1' })).body.id;
  await kc.patch(`/api/updates/${u}/status`, { status: 'installed_by_human' });                                                    // … and "installed" in A
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const f = (await kc.upload({ purpose: 'photo' }, png, 'p.png')).body.file;
  const p = (await kc.post('/api/panels', { equipment_id: e.id, title: 'SAMPLE panel', file_id: f.id })).body.panel;
  await kc.post(`/api/panels/${p.id}/pins`, { x: 0.5, y: 0.5, provenance: 'team', label: 'SAMPLE pin' });
  exp = (await aAdmin.get('/api/admin/export')).body;
});
after(async () => { await A.close(); await B.close(); });

test('export contains content only: no accounts, password hashes, user ids, sign-offs, approvals or files', () => {
  const { note, ...body } = exp; const s = JSON.stringify(body);   // the note is explanatory text that mentions what is NOT included
  assert.equal(exp.format, 'avl-hub-content'); assert.equal(exp.version, 1);
  for (const bad of ['password', 'argon2', 'created_by', 'updated_by', 'signed_by', 'adminA', 'techA', 'trainerA', 'session', 'approved_by']) assert.ok(!s.includes(bad), `export must not contain "${bad}"`);
  assert.equal(exp.equipment.length, 1); assert.equal(exp.modules[0].videos.length, 1); assert.deepEqual(exp.source_domains, ['example-maker.com']);
});

test('only administrators can export or import', async () => {
  assert.equal((await bTech.get('/api/admin/export')).status, 403);
  assert.equal((await bTech.post('/api/admin/import', { data: exp })).status, 403);
  assert.equal((await B.client().post('/api/admin/import', { data: exp })).status, 401);
});

test('dry run reports what would happen and changes nothing', async () => {
  const before = snapshot(B);
  const r = await bAdmin.post('/api/admin/import', { data: exp, dry_run: true });
  assert.equal(r.status, 200); assert.equal(r.body.dry_run, true); assert.equal(r.body.added.equipment, 1); assert.equal(r.body.added.modules, 1);
  assert.deepEqual(snapshot(B), before, 'nothing stored by a dry run');
});

test('import adds content as DRAFT, keeps provenance, attributes it to the importing admin, and is audited', async () => {
  const r = await bAdmin.post('/api/admin/import', { data: exp });
  assert.equal(r.status, 200); assert.equal(r.body.dry_run, false); assert.deepEqual(r.body.added.equipment, 1);
  const e = (await bAdmin.get(`/api/equipment/${exp.equipment[0].id}`)).body.equipment;
  assert.equal(e.status, 'draft', 'approved items arrive as Draft: an approval is never imported'); assert.equal(e.approvals.length, 0);
  assert.deepEqual(e.fields.map(f => `${f.key}:${f.provenance}`), ['note:ai', 'power:verify', 'rack:manufacturer']);
  assert.equal(e.fields.find(f => f.key === 'power').value, '', 'VERIFY stays empty');
  const adminB = B.db.prepare("SELECT id FROM users WHERE username='adminB'").get().id;
  assert.equal(B.db.prepare('SELECT created_by FROM equipment').get().created_by, adminB);
  assert.equal(B.db.prepare('SELECT status FROM equipment_updates').get().status, 'available', 'an update is never imported as "installed"');
  assert.equal((await bAdmin.get(`/api/modules/${exp.modules[0].id}`)).body.module.status, 'draft');
  assert.ok(B.db.prepare("SELECT 1 FROM audit_log WHERE action='import.content' AND actor_id=?").get(adminB));
  assert.equal(r.body.skipped.panels, 1); assert.match(r.body.warnings[0], /photo is not stored on this server/);
});

test('importing again adds nothing and overwrites nothing (safe to repeat)', async () => {
  await bAdmin.patch(`/api/equipment/${exp.equipment[0].id}`, { name: 'SAMPLE renamed on B' });
  const before = snapshot(B);
  const r = await bAdmin.post('/api/admin/import', { data: exp });
  assert.deepEqual(r.body.added, {}); assert.equal(r.body.skipped.equipment, 1);
  assert.deepEqual(snapshot(B), before);
  assert.equal((await bAdmin.get(`/api/equipment/${exp.equipment[0].id}`)).body.equipment.name, 'SAMPLE renamed on B', 'local edits are never overwritten');
});

test('a tampered or invalid file is rejected as a whole: not one row is added', async () => {
  const C = await harness(); const ca = await C.as(await C.makeUser('admin')); const before = snapshot(C);
  const cases = {
    'unknown field': d => { d.equipment[0].is_admin = true; },
    'wrong version': d => { d.version = 2; },
    'wrong format': d => { d.format = 'something-else'; },
    'bad provenance': d => { fld(d, 'rack').provenance = 'guess'; },
    'javascript: URL': d => { fld(d, 'rack').source_url = 'javascript:alert(1)'; },
    'http (not https) URL': d => { d.updates[0].source_url = 'http://support.example-maker.com/x'; },
    'VERIFY with a value': d => { fld(d, 'power').value = 'invented spec'; },
    'value missing for non-VERIFY': d => { fld(d, 'note').value = ''; },
    'manufacturer source not an official domain': d => { d.source_domains = []; },
    'manufacturer source missing': d => { delete fld(d, 'rack').source_url; },
    'bad id': d => { d.equipment[0].id = '../../etc/passwd'; },
    'module points at missing equipment': d => { d.modules[0].equipment_id = crypto.randomUUID(); },
    'issue points at missing equipment': d => { d.issues[0].equipment_id = crypto.randomUUID(); },
    'video link not allowed (http)': d => { d.modules[0].videos[0].url = 'http://sample.sharepoint.com/x'; },
    'SharePoint video on another host': d => { d.modules[0].videos[0].url = 'https://evil.example.com/x'; },
    'quiz answer out of range': d => { d.modules[0].questions[0].correct_index = 9; },
    'checkpoint answer out of range': d => { d.modules[0].videos[0].checkpoints[0].correct_index = 9; },
    'pin outside the photo': d => { d.panels[0].pins[0].x = 2; },
    'manufacturer pin without an official source': d => { d.panels[0].pins[0].provenance = 'manufacturer'; },
    'duplicate equipment items': d => { d.equipment[0].fields.push({ ...fld(d, 'rack') }); },
    'level out of range': d => { d.modules[0].level = 9; },
    'extra top-level data': d => { d.users = [{ username: 'evil', role: 'admin' }]; },
    '__proto__ key': d => { Object.defineProperty(d, '__proto__', { value: { x: 1 }, enumerable: true }); },
    'not an object': () => 'NOT-OBJECT',
  };
  for (const [name, mutate] of Object.entries(cases)) {
    let d = clone(exp); const r = mutate(d); if (r !== undefined) d = r;
    const res = await ca.post('/api/admin/import', { data: d });
    assert.equal(res.status, 400, `${name} should be rejected (got ${res.status})`);
    assert.deepEqual(snapshot(C), before, `${name}: rows were added by a rejected import`);
  }
  assert.equal(await C.db.prepare("SELECT COUNT(*) n FROM users").get().n, 1, 'no accounts can ever be created by an import');
  await C.close();
});

test('the import can never leave the system without an active administrator (and rolls everything back)', async () => {
  const D = await harness(); const admin = await D.makeUser('admin');
  const actor = D.db.prepare('SELECT * FROM users WHERE id=?').get(admin.id);
  D.db.prepare('UPDATE users SET disabled=1').run();                                  // no active admin at all
  const before = snapshot(D);
  assert.throws(() => importContent(D.db, clone(exp), { actor, config: D.ctx.config }), e => e.code === 'NO_ADMIN');
  assert.deepEqual(snapshot(D), before, 'rolled back completely');
  D.db.prepare('UPDATE users SET disabled=0').run();
  assert.doesNotThrow(() => importContent(D.db, clone(exp), { actor, config: D.ctx.config }));
  await D.close();
});

test('big imports are accepted on the import route only; other routes keep the small body limit', async () => {
  const E = await harness(); const ea = await E.as(await E.makeUser('admin'));
  const d = clone(exp); d.issues = Array.from({ length: 800 }, (_, i) => ({ id: crypto.randomUUID(), kind: 'lesson', title: `SAMPLE ${i}`, body: 'x'.repeat(900), equipment_id: null, status: 'open' }));
  d.equipment = []; d.modules = []; d.updates = []; d.panels = [];
  assert.ok(JSON.stringify(d).length > 700 * 1024);
  const r = await ea.post('/api/admin/import', { data: d }); assert.equal(r.status, 200); assert.equal(r.body.added.issues, 800);
  assert.equal((await ea.post('/api/issues', { kind: 'issue', title: 'x', body: 'y'.repeat(300 * 1024) })).status, 413);
  await E.close();
});
