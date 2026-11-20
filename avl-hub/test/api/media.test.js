'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { harness } = require('../helpers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n%SAMPLE\n');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(1000, 7)]);
const EXE = Buffer.from('MZ\x90\x00SAMPLE-not-allowed');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

let h, ac, tc, kc, vc, eq;
before(async () => {
  h = await harness({ maxPhotoMb: 1, maxDocMb: 1, maxVideoMb: 2 });
  [ac, tc, kc, vc] = [await h.as(await h.makeUser('admin')), await h.as(await h.makeUser('trainer')), await h.as(await h.makeUser('technician')), await h.as(await h.makeUser('viewer'))];
  eq = (await kc.post('/api/equipment', { name: 'SAMPLE Console', fields: [] })).body.equipment;
  await ac.post('/api/sources', { domain: 'example-maker.com' });
});
after(() => h.close());

test('uploads: type is decided by file contents, not by the name or the browser header', async () => {
  assert.equal((await kc.upload({ purpose: 'photo' }, PNG, 'a.png', 'image/png')).status, 201);
  assert.equal((await kc.upload({ purpose: 'photo' }, JPG, 'a.jpg', 'image/jpeg')).status, 201);
  assert.equal((await kc.upload({ purpose: 'photo' }, EXE, 'virus.png', 'image/png')).body.error.code, 'BAD_TYPE');
  assert.equal((await kc.upload({ purpose: 'photo' }, HTML, 'a.png', 'image/png')).status, 415);
  assert.equal((await kc.upload({ purpose: 'photo' }, PDF, 'a.png', 'image/png')).status, 415, 'pdf is not a photo');
  assert.equal((await kc.upload({ purpose: 'document' }, PNG, 'a.pdf', 'application/pdf')).status, 415, 'png is not a document');
  assert.equal((await kc.upload({ purpose: 'document' }, PDF, 'a.pdf', 'application/pdf')).status, 201);
  assert.equal((await kc.upload({ purpose: 'video' }, WEBM, 'a.webm', 'video/webm')).status, 201);
  assert.equal((await kc.upload({ purpose: 'bogus' }, PNG)).status, 400);
  assert.equal((await kc.upload({}, PNG)).status, 400);
});

test('uploads: per-type size limits; nothing left behind on rejection', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(1.2 * 1048576)]);
  assert.equal((await kc.upload({ purpose: 'photo' }, big, 'big.png')).body.error.code, 'TOO_LARGE');
  assert.equal((await kc.upload({ purpose: 'video' }, Buffer.concat([WEBM, Buffer.alloc(2.5 * 1048576)]), 'v.webm')).status, 413);
  const okVideo = await kc.upload({ purpose: 'video' }, Buffer.concat([WEBM, Buffer.alloc(1.5 * 1048576)]), 'v.webm');
  assert.equal(okVideo.status, 201, 'a 1.5 MB video is fine even though photos cap at 1 MB');
  const tmp = path.join(h.ctx.config.uploadDir, '_tmp'); assert.deepEqual(fs.readdirSync(tmp), []);
});

test('uploads: only editors; viewers and signed-out users are refused; CSRF header required', async () => {
  assert.equal((await vc.upload({ purpose: 'photo' }, PNG)).status, 403);
  assert.equal((await h.client().upload({ purpose: 'photo' }, PNG)).status, 401);
  assert.equal((await kc.upload({ purpose: 'photo' }, PNG, 'a.png', 'image/png', { csrf: false })).status, 403);
});

test('files are stored on disk (not in the database) under random ids, with a sanitised display name', async () => {
  const r = await kc.upload({ purpose: 'photo', equipment_id: eq.id }, PNG, '../../etc/<evil>"name".png', 'image/png');
  const f = r.body.file;
  assert.ok(!/[\\/<>"]/.test(f.name) && f.name.length <= 120);
  assert.ok(fs.existsSync(path.join(h.ctx.config.uploadDir, 'files', f.id)), 'bytes on disk');
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE sql LIKE '%BLOB%'").get().n, 0, 'no blob columns anywhere');
  assert.ok(Object.keys(f).every(k => !/path/.test(k)), 'no disk path leaked');
});

test('downloads need sign-in; served with the sniffed type, nosniff and a sandboxing CSP; documents download, video supports Range', async () => {
  const photo = (await kc.upload({ purpose: 'photo' }, PNG, 'p.png')).body.file, doc = (await kc.upload({ purpose: 'document' }, PDF, 'd.pdf')).body.file, vid = (await kc.upload({ purpose: 'video' }, WEBM, 'v.webm')).body.file;
  assert.equal((await h.client().raw(`/api/files/${photo.id}`)).status, 401);
  const a = await vc.raw(`/api/files/${photo.id}`);
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'image/png'); assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
  assert.match(a.headers.get('content-security-policy'), /sandbox/); assert.deepEqual(a.buf, PNG);
  assert.match((await vc.raw(`/api/files/${doc.id}`)).headers.get('content-disposition'), /^attachment/);
  const r = await vc.raw(`/api/files/${vid.id}`, { Range: 'bytes=0-9' });
  assert.equal(r.status, 206); assert.equal(r.buf.length, 10);
  assert.equal((await vc.get('/api/files/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await vc.get('/api/files/..%2f..%2fetc%2fpasswd')).status, 400);
});

test('deleting a file in use is refused', async () => {
  const photo = (await kc.upload({ purpose: 'photo' }, PNG, 'p.png')).body.file;
  const panel = (await kc.post('/api/panels', { equipment_id: eq.id, title: 'SAMPLE panel', file_id: photo.id })).body.panel;
  assert.equal((await tc.del(`/api/files/${photo.id}`)).body.error.code, 'IN_USE');
  assert.equal((await kc.del(`/api/files/${photo.id}`)).status, 403);
  await ac.del(`/api/panels/${panel.id}`);
  assert.equal((await tc.del(`/api/files/${photo.id}`)).status, 200);
  assert.equal((await vc.get(`/api/files/${photo.id}`)).status, 404);
});

test('lesson videos: SharePoint embeds only from SharePoint; other kinds validated; learners never see checkpoint answers', async () => {
  const m = (await tc.post('/api/modules', { title: 'SAMPLE video module', level: 1 })).body.module;
  const add = b => tc.post(`/api/modules/${m.id}/videos`, b);
  assert.equal((await add({ title: 'x', kind: 'sharepoint_embed', url: 'https://evil.example.com/embed' })).body.error.code, 'BAD_SHAREPOINT_URL');
  assert.equal((await add({ title: 'x', kind: 'sharepoint_embed', url: 'https://sharepoint.com.evil.org/x' })).status, 400, 'suffix trick');
  assert.equal((await add({ title: 'x', kind: 'sharepoint_embed', url: 'http://sample.sharepoint.com/x' })).status, 400, 'https only');
  assert.equal((await add({ title: 'x', kind: 'sharepoint_embed', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await add({ title: 'x', kind: 'link', url: 'http://example.com/v' })).status, 400);
  assert.equal((await add({ title: 'x', kind: 'upload' })).status, 400);
  assert.equal((await add({ title: 'x', kind: 'upload', file_id: (await kc.upload({ purpose: 'photo' }, PNG)).body.file.id })).status, 400, 'upload must be a video file');
  const sp = await add({ title: 'SAMPLE SharePoint video', kind: 'sharepoint_embed', url: 'https://sample-tenant.sharepoint.com/_layouts/15/embed.aspx?uniqueId=SAMPLE' });
  assert.equal(sp.status, 201);
  assert.equal((await add({ title: 'SAMPLE link', kind: 'link', url: 'https://example.com/v' })).status, 201);
  const up = await add({ title: 'SAMPLE upload', kind: 'upload', file_id: (await kc.upload({ purpose: 'video' }, WEBM, 'v.webm')).body.file.id });
  assert.equal(up.status, 201);

  const cp = await tc.post(`/api/videos/${sp.body.id}/checkpoints`, { at_seconds: 30, prompt: 'SAMPLE: what did you see?', options: ['A', 'B'], correct_index: 1 });
  assert.equal(cp.status, 201);
  assert.equal((await tc.post(`/api/videos/${sp.body.id}/checkpoints`, { at_seconds: -1, prompt: 'q', options: ['A', 'B'], correct_index: 0 })).status, 400);
  const learner = (await kc.get(`/api/modules/${m.id}/videos`)).body.videos.find(v => v.id === sp.body.id);
  assert.ok(!('correct_index' in learner.checkpoints[0]));
  assert.ok('correct_index' in (await tc.get(`/api/modules/${m.id}/videos`)).body.videos[0].checkpoints[0]);
  const wrong = await kc.post(`/api/checkpoints/${cp.body.id}/answer`, { choice: 0 });
  assert.deepEqual([wrong.body.correct, wrong.body.correct_index], [false, 1]);
  assert.equal((await kc.post(`/api/checkpoints/${cp.body.id}/answer`, { choice: 1 })).body.correct, true);
  assert.equal((await kc.get(`/api/modules/${m.id}/videos`)).body.videos[0].checkpoints[0].answered.correct, true, 'latest answer remembered per user');
  assert.equal((await vc.post(`/api/checkpoints/${cp.body.id}/answer`, { choice: 1 })).status, 403, 'viewers read only');
  assert.equal((await kc.post(`/api/modules/${m.id}/videos`, { title: 'x', kind: 'link', url: 'https://example.com' })).status, 403);
  assert.throws(() => h.db.prepare('UPDATE checkpoint_responses SET correct=1').run(), /append-only/);
});

test('editing approved training material by adding a video returns it to Needs Review', async () => {
  const m = (await tc.post('/api/modules', { title: 'SAMPLE approved module', level: 2 })).body.module;
  await ac.post(`/api/modules/${m.id}/approve`);
  await tc.post(`/api/modules/${m.id}/videos`, { title: 'SAMPLE', kind: 'link', url: 'https://example.com/v' });
  assert.equal((await tc.get(`/api/modules/${m.id}`)).body.module.status, 'needs_review');
});

test('SharePoint host pinning: when SHAREPOINT_HOSTS is set only that tenant is accepted and the CSP follows', async () => {
  const h2 = await harness({ sharepointHosts: ['moody-sample.sharepoint.com'] }); const t = await h2.as(await h2.makeUser('trainer'));
  const m = (await t.post('/api/modules', { title: 'SAMPLE', level: 1 })).body.module;
  assert.equal((await t.post(`/api/modules/${m.id}/videos`, { title: 'x', kind: 'sharepoint_embed', url: 'https://other.sharepoint.com/x' })).status, 400);
  assert.equal((await t.post(`/api/modules/${m.id}/videos`, { title: 'x', kind: 'sharepoint_embed', url: 'https://moody-sample.sharepoint.com/x' })).status, 201);
  assert.match((await fetch(h2.base + '/healthz')).headers.get('content-security-policy'), /frame-src https:\/\/moody-sample\.sharepoint\.com(;|$)/);
  await h2.close();
});

test('photo panels: pins are sourced; manufacturer pins need an official domain; VERIFY pins are unlabeled; edits and approval follow the rules', async () => {
  const photo = (await kc.upload({ purpose: 'photo' }, PNG, 'p.png')).body.file;
  const p = (await kc.post('/api/panels', { equipment_id: eq.id, title: 'SAMPLE rear panel', file_id: photo.id })).body.panel;
  const pin = (o) => kc.post(`/api/panels/${p.id}/pins`, { x: 0.5, y: 0.5, provenance: 'team', label: 'SAMPLE input', ...o });
  assert.equal((await pin({ provenance: 'manufacturer' })).body.error.code, 'SOURCE_REQUIRED');
  assert.equal((await pin({ provenance: 'manufacturer', source_url: 'https://evil.example.org/m' })).body.error.code, 'SOURCE_NOT_OFFICIAL');
  assert.equal((await pin({ provenance: 'verify' })).body.error.code, 'VERIFY_MUST_BE_EMPTY');
  assert.equal((await pin({ label: '' })).body.error.code, 'LABEL_REQUIRED');
  assert.equal((await pin({ x: 1.2 })).status, 400); assert.equal((await pin({ y: -0.1 })).status, 400);
  assert.equal((await pin({ source_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await pin({ provenance: 'manufacturer', source_url: 'https://support.example-maker.com/rear' })).status, 201);
  assert.equal((await pin({ provenance: 'ai', label: 'SAMPLE AI guess' })).status, 201);
  const withVerify = await pin({ provenance: 'verify', label: '', x: 0.1, y: 0.9 });
  assert.equal(withVerify.body.panel.verify_count, 1);
  assert.equal((await vc.post(`/api/panels/${p.id}/pins`, { x: 0.5, y: 0.5, provenance: 'team', label: 'x' })).status, 403);

  let r = await ac.post(`/api/panels/${p.id}/approve`, {});
  assert.equal(r.body.error.code, 'VERIFY_ITEMS_REMAIN');
  assert.equal((await ac.post(`/api/panels/${p.id}/approve`, { override: true })).body.error.code, 'OVERRIDE_REASON_REQUIRED');
  assert.equal((await kc.post(`/api/panels/${p.id}/approve`, { override: true, override_reason: 'SAMPLE reason' })).status, 403);
  r = await ac.post(`/api/panels/${p.id}/approve`, { override: true, override_reason: 'SAMPLE: manual pending' });
  assert.equal(r.body.panel.status, 'approved');
  const pinId = r.body.panel.pins[0].id;
  r = await kc.patch(`/api/pins/${pinId}`, { x: 0.4, y: 0.4, provenance: 'team', label: 'SAMPLE moved' });
  assert.equal(r.body.panel.status, 'needs_review', 'editing approved material returns it to Needs Review');
  assert.throws(() => h.db.prepare('DELETE FROM panel_approvals').run(), /append-only/);
  assert.equal((await ac.del(`/api/panels/${p.id}`)).status, 200);
  assert.equal((await ac.get(`/api/panels/${p.id}`)).status, 404);
});
