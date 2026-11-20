'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { harness } = require('../helpers');

let h, ac, a, b, tc, kc, eq;
const T = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const edit = (c, id, body, at, extra = {}) => c.req('PATCH', `/api/equipment/${id}`, body, { headers: { 'x-edit-time': at, ...extra } });
// Records in these tests were 'last edited' long ago, like real library entries (a record cannot be edited before it existed).
const age = (table, id, hours) => h.db.prepare(`UPDATE ${table} SET edit_at=? WHERE id=?`).run(T(-hours * 3600e3), id);
const newEq = async (name = 'SAMPLE Mixer', hours = 72) => { const e = (await a.post('/api/equipment', { name, fields: [] })).body.equipment; age('equipment', e.id, hours); return e; };

before(async () => {
  h = await harness();
  const [u1, u2] = [await h.makeUser('technician', 'phone'), await h.makeUser('technician', 'laptop')];
  [ac, a, b, tc, kc] = [await h.as(await h.makeUser('admin')), await h.as(u1), await h.as(u2), await h.as(await h.makeUser('trainer')), await h.as(await h.makeUser('technician'))];
  eq = await newEq();
});
after(() => h.close());

test('last-writer-wins by EDIT time: an older offline edit that syncs late does not overwrite a newer edit', async () => {
  const e = await newEq('SAMPLE LWW-1');
  const phoneEditedAt = T(-2 * 3600e3), laptopEditedAt = T(-1 * 3600e3);          // phone edited at -2h (offline), laptop at -1h (online)
  const laptop = await edit(b, e.id, { name: 'SAMPLE laptop version' }, laptopEditedAt);
  assert.equal(laptop.body.equipment.name, 'SAMPLE laptop version'); assert.notEqual(laptop.body.superseded, true);
  const phone = await edit(a, e.id, { name: 'SAMPLE phone version' }, phoneEditedAt);   // arrives last, but was made first
  assert.equal(phone.status, 200); assert.equal(phone.body.superseded, true); assert.equal(phone.body.applied, false);
  assert.equal(phone.body.equipment.name, 'SAMPLE laptop version', 'the response tells the phone what actually won');
  assert.equal((await a.get(`/api/equipment/${e.id}`)).body.equipment.name, 'SAMPLE laptop version');
  const log = (await ac.get('/api/audit?limit=20')).body.entries.find(x => x.action === 'sync.superseded' && x.entity_id === e.id);
  assert.ok(log, 'the discarded edit is recorded in the audit log'); assert.equal(log.actor_name, 'phone');
});

test('last-writer-wins: the later edit wins regardless of arrival order', async () => {
  const e = await newEq('SAMPLE LWW-2');
  const r1 = await edit(a, e.id, { name: 'SAMPLE phone first' }, T(-3 * 3600e3));
  const r2 = await edit(b, e.id, { name: 'SAMPLE laptop later' }, T(-3600e3));
  assert.equal(r1.body.superseded, undefined); assert.equal(r2.body.superseded, undefined);
  assert.equal((await a.get(`/api/equipment/${e.id}`)).body.equipment.name, 'SAMPLE laptop later');
  // now the phone makes a genuinely newer edit while offline and syncs it afterwards
  const r3 = await edit(a, e.id, { name: 'SAMPLE phone newest' }, T(-60e3));
  assert.equal(r3.body.superseded, undefined); assert.equal(r3.body.equipment.name, 'SAMPLE phone newest');
});

test('ties go to the later arrival; different records never interfere', async () => {
  const e1 = await newEq('SAMPLE tie'), e2 = await newEq('SAMPLE other'); const at = T(-5000);
  await edit(a, e1.id, { name: 'SAMPLE tie A' }, at); await edit(b, e1.id, { name: 'SAMPLE tie B' }, at);
  assert.equal((await a.get(`/api/equipment/${e1.id}`)).body.equipment.name, 'SAMPLE tie B');
  assert.equal((await edit(a, e2.id, { name: 'SAMPLE other edited' }, T(-9 * 3600e3))).body.superseded, undefined, 'older time on a different record is fine');
});

test('clock safety: a future timestamp is clamped to arrival time and cannot lock others out; garbage falls back to arrival time', async () => {
  const e = await newEq('SAMPLE clock');
  await edit(a, e.id, { name: 'SAMPLE from a fast clock' }, T(+24 * 3600e3));           // claims to be tomorrow; treated as "now"
  const r = await edit(b, e.id, { name: 'SAMPLE honest later edit' }, T(+10));           // a moment later
  assert.equal(r.body.superseded, undefined, 'a fast clock must not win forever'); assert.equal(r.body.equipment.name, 'SAMPLE honest later edit');
  assert.equal((await edit(a, e.id, { name: 'SAMPLE garbage time' }, 'not-a-date')).status, 200);
  const stored = h.db.prepare('SELECT edit_at FROM equipment WHERE id=?').get(e.id).edit_at;
  assert.ok(Date.parse(stored) <= Date.now(), 'stored edit time is never in the future');
});

test('clock safety: an absurdly old timestamp is clamped to 90 days, so it cannot beat newer content', async () => {
  const fresh = await newEq('SAMPLE fresh', 24);                                          // edited a day ago
  assert.equal((await edit(a, fresh.id, { name: 'SAMPLE claims 2001' }, '2001-01-01T00:00:00Z')).body.superseded, true);
  const stale = await newEq('SAMPLE stale', 24 * 200);                                    // untouched for 200 days
  const r = await edit(a, stale.id, { name: 'SAMPLE claims 2001 too' }, '2001-01-01T00:00:00Z');
  assert.equal(r.body.superseded, undefined, 'clamped to 90 days ago, which is still newer than a 200-day-old record');
});

test('LWW also applies to issues, update status, modules and pins', async () => {
  const i = (await a.post('/api/issues', { kind: 'issue', title: 'SAMPLE issue' })).body.issue; age('issues', i.id, 48);
  assert.equal((await b.req('PATCH', `/api/issues/${i.id}`, { title: 'SAMPLE newer' }, { headers: { 'x-edit-time': T(-1000) } })).status, 403, 'technicians still can only edit their own');
  await a.req('PATCH', `/api/issues/${i.id}`, { title: 'SAMPLE a-newer' }, { headers: { 'x-edit-time': T(-1000) } });
  assert.equal((await a.req('PATCH', `/api/issues/${i.id}`, { title: 'SAMPLE a-older' }, { headers: { 'x-edit-time': T(-3600e3) } })).body.superseded, true);
  assert.equal((await a.get('/api/issues')).body.issues.find(x => x.id === i.id).title, 'SAMPLE a-newer');

  const u = (await a.post('/api/updates', { equipment_id: eq.id, kind: 'firmware', available_version: 'SAMPLE-1' })).body.id; age('equipment_updates', u, 48);
  await b.req('PATCH', `/api/updates/${u}/status`, { status: 'scheduled' }, { headers: { 'x-edit-time': T(-1000) } });
  assert.equal((await a.req('PATCH', `/api/updates/${u}/status`, { status: 'skipped' }, { headers: { 'x-edit-time': T(-3600e3) } })).body.superseded, true);
  assert.equal(h.db.prepare('SELECT status FROM equipment_updates WHERE id=?').get(u).status, 'scheduled');

  const m = (await tc.post('/api/modules', { title: 'SAMPLE m', level: 1 })).body.module; age('training_modules', m.id, 48);
  await tc.req('PATCH', `/api/modules/${m.id}`, { summary: 'SAMPLE new' }, { headers: { 'x-edit-time': T(-1000) } });
  assert.equal((await ac.req('PATCH', `/api/modules/${m.id}`, { summary: 'SAMPLE old' }, { headers: { 'x-edit-time': T(-3600e3) } })).body.superseded, true);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const file = (await a.upload({ purpose: 'photo' }, png, 'p.png')).body.file;
  const panel = (await a.post('/api/panels', { equipment_id: eq.id, title: 'SAMPLE panel', file_id: file.id })).body.panel;
  const pinId = crypto.randomUUID();
  const made = await a.post(`/api/panels/${panel.id}/pins`, { id: pinId, x: 0.1, y: 0.1, provenance: 'team', label: 'SAMPLE pin' });
  assert.equal(made.body.panel.pins[0].id, pinId, 'client-chosen ids are honoured'); age('panel_pins', pinId, 48);
  await b.req('PATCH', `/api/pins/${pinId}`, { x: 0.2, y: 0.2, provenance: 'team', label: 'SAMPLE moved by laptop' }, { headers: { 'x-edit-time': T(-1000) } });
  const late = await a.req('PATCH', `/api/pins/${pinId}`, { x: 0.9, y: 0.9, provenance: 'team', label: 'SAMPLE stale phone move' }, { headers: { 'x-edit-time': T(-3600e3) } });
  assert.equal(late.body.superseded, true); assert.equal(late.body.panel.pins[0].label, 'SAMPLE moved by laptop');
});

test('idempotency: replaying a queued operation never runs it twice; ids are honoured; rejections are not remembered', async () => {
  const key = 'op-' + crypto.randomUUID(), id = crypto.randomUUID();
  const send = () => a.req('POST', '/api/equipment', { id, name: 'SAMPLE once', fields: [] }, { headers: { 'idempotency-key': key } });
  const first = await send(), again = await send();
  assert.equal(first.status, 201); assert.equal(again.status, 201); assert.deepEqual(again.body, first.body);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM equipment WHERE id=?').get(id).n, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='equipment.create' AND entity_id=?").get(id).n, 1, 'audited once');
  const dup = await a.post('/api/equipment', { id, name: 'SAMPLE again', fields: [] });
  assert.equal(dup.body.error.code, 'ID_EXISTS', 'same id with a new key is refused');
  assert.equal((await a.req('POST', '/api/issues', { kind: 'issue', title: 'x' }, { headers: { 'idempotency-key': key } })).status, 422, 'a key cannot be reused for a different request');
  assert.equal((await b.req('POST', '/api/equipment', { id: crypto.randomUUID(), name: 'SAMPLE by laptop', fields: [] }, { headers: { 'idempotency-key': key } })).status, 201, 'keys are per user');
  const bad = 'op-' + crypto.randomUUID();
  const rej = () => a.req('POST', '/api/equipment', { name: 'SAMPLE bad', fields: [{ key: 'k', provenance: 'verify', value: 'x' }] }, { headers: { 'idempotency-key': bad } });
  assert.equal((await rej()).status, 400); assert.equal((await rej()).status, 400, 'still validated, not replayed from a stored success');
  assert.equal((await a.req('POST', '/api/equipment', { name: 'x', fields: [] }, { headers: { 'idempotency-key': 'short' } })).status, 400);
});

test('sign-offs and approvals are append-only, attributed to the signed-in user, and timestamped by the server even if queued offline', async () => {
  const trainer = h.db.prepare("SELECT id FROM users WHERE role='trainer'").get(); const trainee = (await h.makeUser('technician', 'trainee'));
  const m = (await tc.post('/api/modules', { title: 'SAMPLE signoff module', level: 1 })).body.module;
  const q = await tc.post(`/api/modules/${m.id}/questions`, { prompt: 'SAMPLE q', options: ['a', 'b'], correct_index: 1 });
  const sk = (await tc.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE skill' })).body.id;
  await ac.post(`/api/modules/${m.id}/approve`);
  const tr = await h.as(trainee);
  await tr.post(`/api/modules/${m.id}/quiz-attempts`, { answers: { [q.body.id]: 1 } });
  await tc.post('/api/practical-scores', { trainee_id: trainee.id, skill_id: sk, score: 3 });
  const key = 'op-' + crypto.randomUUID(), longAgo = T(-72 * 3600e3);
  const so = () => tc.req('POST', '/api/signoffs', { trainee_id: trainee.id, module_id: m.id }, { headers: { 'idempotency-key': key, 'x-edit-time': longAgo } });
  const r1 = await so(), r2 = await so();
  assert.equal(r1.status, 201); assert.deepEqual(r2.body, r1.body);
  const row = h.db.prepare('SELECT * FROM signoffs WHERE trainee_id=?').get(trainee.id);
  assert.equal(row.signed_by, trainer.id, 'attributed to the signed-in session user');
  assert.ok(Date.now() - Date.parse(row.created_at) < 60e3, 'created_at is server time: a queued sign-off cannot be backdated');
  const audit = (await ac.get('/api/audit?limit=10')).body.entries.find(e => e.action === 'signoff.create');
  assert.equal(JSON.parse(audit.detail).occurred_at.slice(0, 13), longAgo.slice(0, 13), 'when the trainer actually did it is kept separately');
  assert.equal((await tc.post('/api/signoffs', { trainee_id: trainee.id, module_id: m.id })).body.error.code, 'ALREADY_SIGNED_OFF', 'never overwritten');
  assert.throws(() => h.db.prepare('UPDATE signoffs SET signed_by=?').run(trainee.id), /append-only/);
});

test('an approval applies only to the version that was reviewed (stale offline approvals are refused)', async () => {
  const e = await newEq('SAMPLE review'); const v = e.version;
  await a.req('PATCH', `/api/equipment/${e.id}`, { name: 'SAMPLE review edited' });            // someone edits after the approver looked
  const stale = await ac.post(`/api/equipment/${e.id}/approve`, { reviewed_version: v });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'STALE_REVIEW');
  const cur = (await ac.get(`/api/equipment/${e.id}`)).body.equipment;
  assert.equal((await ac.post(`/api/equipment/${e.id}/approve`, { reviewed_version: cur.version })).body.equipment.status, 'approved');
  const m = (await tc.post('/api/modules', { title: 'SAMPLE rv', level: 1 })).body.module;
  await tc.patch(`/api/modules/${m.id}`, { summary: 'SAMPLE changed' });
  assert.equal((await ac.post(`/api/modules/${m.id}/approve`, { reviewed_version: m.version })).body.error.code, 'STALE_REVIEW');
  assert.equal((await ac.post(`/api/modules/${m.id}/approve`, {})).status, 200, 'omitting it still works (online approvals)');
});

test('the edit-time header grants no extra permissions', async () => {
  const r = await kc.req('POST', '/api/modules/00000000-0000-4000-8000-000000000000/approve', {}, { headers: { 'x-edit-time': T(-1000), 'idempotency-key': 'op-' + crypto.randomUUID() } });
  assert.equal(r.status, 403);
});
