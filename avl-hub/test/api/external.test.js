'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('../helpers');

let h, ac, kc, vc, calls = [];
const fakeFetch = async (u, o) => {
  calls.push({ u: String(u), o });
  if (String(u).includes('brave.com')) return { ok: true, json: async () => ({ web: { results: [
    { title: 'SAMPLE official page', url: 'https://support.example-maker.com/p1', description: 'SAMPLE snippet' },
    { title: 'Off-list page', url: 'https://random-blog.example.net/p2', description: 'should be dropped' }] } }) };
  return { ok: true, json: async () => ({ content: [{ text: '{"summary":"SAMPLE draft.","unknown":["power rating"]}' }] }) };
};
before(async () => {
  h = await harness({ fetchImpl: fakeFetch, braveApiKey: 'test-brave', anthropicApiKey: 'test-anthropic', aiRatePerHour: 3 });
  [ac, kc, vc] = [await h.as(await h.makeUser('admin')), await h.as(await h.makeUser('technician')), await h.as(await h.makeUser('viewer'))];
});
after(() => h.close());

test('research: refused without admin-listed domains; restricted to them; off-list results dropped; key stays server-side', async () => {
  assert.equal((await kc.post('/api/research', { query: 'SAMPLE mixer manual' })).body.error.code, 'NO_SOURCES');
  await ac.post('/api/sources', { domain: 'example-maker.com' });
  const r = await kc.post('/api/research', { query: 'SAMPLE mixer manual' });
  assert.equal(r.status, 200); assert.equal(r.body.results.length, 1); assert.match(r.body.results[0].url, /example-maker\.com/);
  assert.match(decodeURIComponent(calls.at(-1).u), /site:example-maker\.com/);
  assert.equal(calls.at(-1).o.headers['X-Subscription-Token'], 'test-brave');
  assert.ok(!JSON.stringify(r.body).includes('test-brave'));
  assert.equal((await vc.post('/api/research', { query: 'SAMPLE mixer' })).status, 403);
});

test('AI draft is labelled ai, flagged not auto-approved, never saved; viewer refused', async () => {
  const before = h.db.prepare('SELECT COUNT(*) n FROM equipment').get().n;
  const r = await kc.post('/api/ai/draft', { source_text: 'SAMPLE label text for a mixer' });
  assert.equal(r.status, 200);
  assert.equal(r.body.draft.provenance, 'ai'); assert.equal(r.body.draft.auto_approved, false); assert.deepEqual(r.body.draft.unknown, ['power rating']);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM equipment').get().n, before);
  const sent = JSON.parse(calls.at(-1).o.body);
  assert.match(sent.system, /Never invent/); assert.equal(calls.at(-1).o.headers['x-api-key'], 'test-anthropic');
  assert.equal((await vc.post('/api/ai/draft', { source_text: 'SAMPLE label text' })).status, 403);
});

test('search/AI are rate limited per user', async () => {
  const k2 = await h.as(await h.makeUser('technician'));
  let last; for (let i = 0; i < 5; i++) last = await k2.post('/api/ai/draft', { source_text: 'SAMPLE label text for a mixer' });
  assert.equal(last.status, 429);
});

test('not configured: clear 503, nothing is sent', async () => {
  const h2 = await harness({ fetchImpl: fakeFetch }); const a = await h2.as(await h2.makeUser('admin'));
  await a.post('/api/sources', { domain: 'example-maker.com' });
  assert.equal((await a.post('/api/research', { query: 'SAMPLE mixer' })).body.error.code, 'NOT_CONFIGURED');
  assert.equal((await a.post('/api/ai/draft', { source_text: 'SAMPLE label text' })).body.error.code, 'NOT_CONFIGURED');
  await h2.close();
});

test('installation assistant: steps follow provenance rules; progress is per user; editing approved equipment needs review', async () => {
  const e = (await kc.post('/api/equipment', { name: 'SAMPLE Projector', fields: [] })).body.equipment;
  const bad = await kc.put(`/api/equipment/${e.id}/install-steps`, { steps: [{ text: 'SAMPLE step', provenance: 'manufacturer', source_url: 'https://evil.example.org/x' }] });
  assert.equal(bad.body.error.code, 'SOURCE_NOT_OFFICIAL');
  assert.equal((await kc.put(`/api/equipment/${e.id}/install-steps`, { steps: [{ text: 'SAMPLE step', provenance: 'verify' }] })).status, 400);
  const ok = await kc.put(`/api/equipment/${e.id}/install-steps`, { steps: [{ text: 'SAMPLE step one', provenance: 'team' }, { text: 'SAMPLE step two', provenance: 'ai' }] });
  assert.equal(ok.body.steps.length, 2);
  assert.equal((await vc.put(`/api/equipment/${e.id}/install-steps`, { steps: [] })).status, 403);
  const [s1] = ok.body.steps;
  assert.equal((await kc.put(`/api/equipment/${e.id}/install-progress`, { done: [s1.id] })).status, 200);
  assert.deepEqual((await kc.get(`/api/equipment/${e.id}/install-steps`)).body.done, [s1.id]);
  assert.deepEqual((await ac.get(`/api/equipment/${e.id}/install-steps`)).body.done, [], 'progress is per user');
  await ac.post(`/api/equipment/${e.id}/approve`, {});
  await kc.put(`/api/equipment/${e.id}/install-steps`, { steps: [{ text: 'SAMPLE changed', provenance: 'team' }] });
  assert.equal((await kc.get(`/api/equipment/${e.id}`)).body.equipment.status, 'needs_review');
});
