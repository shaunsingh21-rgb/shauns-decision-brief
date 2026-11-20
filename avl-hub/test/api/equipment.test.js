'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('../helpers');

let h, ac, kc, vc;
before(async () => {
  h = await harness();
  [ac, kc, vc] = [await h.as(await h.makeUser('admin')), await h.as(await h.makeUser('technician')), await h.as(await h.makeUser('viewer'))];
  await ac.post('/api/sources', { domain: 'Example-Maker.com' });     // SAMPLE official domain
});
after(() => h.close());

const sample = (fields) => ({ name: 'SAMPLE Mixer', manufacturer: 'SAMPLE Co', fields });

test('provenance: VERIFY must be empty, other provenance needs a value', async () => {
  assert.equal((await kc.post('/api/equipment', sample([{ key: 'channels', provenance: 'verify', value: '16' }]))).body.error.code, 'VERIFY_MUST_BE_EMPTY');
  assert.equal((await kc.post('/api/equipment', sample([{ key: 'channels', provenance: 'team' }]))).body.error.code, 'VALUE_REQUIRED');
  assert.equal((await kc.post('/api/equipment', sample([{ key: 'channels', provenance: 'bogus', value: '1' }]))).status, 400);
});

test('manufacturer provenance needs a source on an admin-listed domain; AI and team do not pretend to', async () => {
  const f = { key: 'ports', provenance: 'manufacturer', value: 'SAMPLE value' };
  assert.equal((await kc.post('/api/equipment', sample([f]))).body.error.code, 'SOURCE_REQUIRED');
  assert.equal((await kc.post('/api/equipment', sample([{ ...f, source_url: 'https://evil.example.org/spec' }]))).body.error.code, 'SOURCE_NOT_OFFICIAL');
  assert.equal((await kc.post('/api/equipment', sample([{ ...f, source_url: 'https://example-maker.com.evil.org/x' }]))).body.error.code, 'SOURCE_NOT_OFFICIAL', 'suffix tricks fail');
  assert.equal((await kc.post('/api/equipment', sample([{ ...f, source_url: 'http://example-maker.com/x' }]))).status, 400, 'https only');
  assert.equal((await kc.post('/api/equipment', sample([{ ...f, source_url: 'javascript:alert(1)' }]))).status, 400);
  assert.equal((await kc.post('/api/equipment', sample([{ ...f, source_url: 'https://support.example-maker.com/x' }]))).status, 201, 'subdomain of listed domain ok');
  assert.equal((await kc.post('/api/equipment', sample([{ key: 'note', provenance: 'ai', value: 'SAMPLE AI draft text' }]))).status, 201);
});

test('AI-drafted content stays labelled and is never auto-approved', async () => {
  const e = (await kc.post('/api/equipment', sample([{ key: 'note', provenance: 'ai', value: 'SAMPLE AI draft text' }]))).body.equipment;
  assert.equal(e.status, 'draft'); assert.equal(e.fields[0].provenance, 'ai');
  assert.equal((await kc.post(`/api/equipment/${e.id}/approve`, {})).status, 403, 'technician cannot approve');
});

test('approving with VERIFY items needs an explicit override with a reason; approvals are recorded', async () => {
  const e = (await kc.post('/api/equipment', sample([{ key: 'power', provenance: 'verify' }, { key: 'rack', provenance: 'team', value: 'SAMPLE 2U' }]))).body.equipment;
  assert.deepEqual(e.verify_keys, ['power']);
  let r = await ac.post(`/api/equipment/${e.id}/approve`, {});
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'VERIFY_ITEMS_REMAIN'); assert.deepEqual(r.body.error.verify_keys, ['power']);
  assert.equal((await ac.post(`/api/equipment/${e.id}/approve`, { override: true })).body.error.code, 'OVERRIDE_REASON_REQUIRED');
  r = await ac.post(`/api/equipment/${e.id}/approve`, { override: true, override_reason: 'SAMPLE: spec sheet pending' });
  assert.equal(r.body.equipment.status, 'approved'); assert.equal(r.body.equipment.approvals[0].override, 1);
  assert.ok((await ac.get('/api/audit')).body.entries.some(x => x.action === 'equipment.approve_override'));
});

test('editing approved equipment returns it to Needs Review; clean approval needs no override', async () => {
  const e = (await kc.post('/api/equipment', sample([{ key: 'rack', provenance: 'team', value: 'SAMPLE 2U' }]))).body.equipment;
  assert.equal((await ac.post(`/api/equipment/${e.id}/approve`, {})).body.equipment.status, 'approved');
  const r = await kc.patch(`/api/equipment/${e.id}`, { fields: [{ key: 'rack', provenance: 'team', value: 'SAMPLE 3U' }] });
  assert.equal(r.body.equipment.status, 'needs_review');
  const v = await kc.patch(`/api/equipment/${e.id}`, { fields: [{ key: 'rack', provenance: 'verify' }] });
  assert.deepEqual(v.body.equipment.verify_keys, ['rack']);
});

test('viewer can read but not write; deleted equipment disappears; output is stored raw (client escapes)', async () => {
  const e = (await kc.post('/api/equipment', { name: 'SAMPLE <img src=x onerror=alert(1)>', fields: [] })).body.equipment;
  assert.equal((await vc.get(`/api/equipment/${e.id}`)).status, 200);
  assert.equal((await vc.post('/api/equipment', sample([]))).status, 403);
  assert.equal((await kc.del(`/api/equipment/${e.id}`)).status, 403);
  assert.equal((await ac.del(`/api/equipment/${e.id}`)).status, 200);
  assert.equal((await vc.get(`/api/equipment/${e.id}`)).status, 404);
  assert.equal((await vc.get('/api/equipment/not%20an%20id')).status, 400, 'ids validated');
});

test('issues: technicians edit only their own; updates record status but never install', async () => {
  const k2 = await h.as(await h.makeUser('technician'));
  const i = (await kc.post('/api/issues', { kind: 'issue', title: 'SAMPLE issue' })).body.issue;
  assert.equal((await k2.patch(`/api/issues/${i.id}`, { status: 'resolved' })).status, 403);
  assert.equal((await kc.patch(`/api/issues/${i.id}`, { status: 'resolved' })).status, 200);
  const e = (await kc.post('/api/equipment', sample([]))).body.equipment;
  const u = (await kc.post('/api/updates', { equipment_id: e.id, kind: 'firmware', available_version: 'SAMPLE-v0' })).body.id;
  assert.equal((await kc.patch(`/api/updates/${u}/status`, { status: 'installed_by_human' })).status, 200);
  const row = h.db.prepare('SELECT status,status_by FROM equipment_updates WHERE id=?').get(u);
  assert.equal(row.status, 'installed_by_human'); assert.ok(row.status_by);
});
