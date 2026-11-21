'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { harness, PW } = require('../helpers');

let h, browser, dir, ac, eq, webm, jpegWithExif;
before(async () => {
  h = await harness({ maxVideoMb: 20 });
  browser = await chromium.launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-e2e-media-'));
  ac = await h.as(await h.makeUser('admin', 'chief'));
  eq = (await ac.post('/api/equipment', { name: 'SAMPLE Stage Box', fields: [] })).body.equipment;
  await ac.post('/api/sources', { domain: 'example-maker.com' });
  // A real, tiny, playable WebM (6s) made with ffmpeg.
  webm = path.join(dir, 'clip.webm');
  const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=15', '-c:v', 'libvpx', '-b:v', '150k', '-an', webm], { stdio: 'pipe' });
  assert.equal(r.status, 0, 'ffmpeg must produce the test clip: ' + String(r.stderr).slice(-200));
  // A JPEG carrying a fake EXIF/GPS segment, to prove the client strips it before upload.
  const p0 = await (await browser.newContext()).newPage(); await p0.goto('about:blank');
  const b64 = await p0.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#ddd'; x.fillRect(0, 0, 600, 400); x.fillStyle = '#123'; x.font = '40px Arial'; x.fillText('SAMPLE PANEL PHOTO', 40, 200); return c.toDataURL('image/jpeg', 0.9).split(',')[1]; });
  const base = Buffer.from(b64, 'base64'); const payload = Buffer.from('Exif\0\0SAMPLE-GPS-LAT-41.88-LON-87.62');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  jpegWithExif = path.join(dir, 'gps.jpg'); fs.writeFileSync(jpegWithExif, Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]));
  await p0.context().close();
});
after(async () => { await browser?.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function open(username, viewport = { width: 1000, height: 900 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(h.base + '/'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(PW); await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Equipment library' }).waitFor(); return page;
}

test('photo panel: camera capture input, EXIF stripped, keyboard-only pin placement, sourced pins, Quiz me', async () => {
  const page = await open('chief');
  await page.evaluate(id => { location.hash = '#/equipment/' + id; }, eq.id);
  await page.getByRole('heading', { name: 'Photo panels' }).waitFor();
  assert.equal(await page.locator('input[type=file][capture=environment]').count(), 1, 'a camera-capture input is offered');
  await page.getByLabel('Name for a new photo panel').fill('SAMPLE rear panel');
  await page.locator('label:has-text("Choose photo") input').setInputFiles(jpegWithExif);
  await page.getByRole('heading', { name: 'SAMPLE rear panel' }).waitFor();

  // The stored photo must not contain the planted EXIF/GPS text.
  const fileId = h.db.prepare('SELECT file_id FROM photo_panels').get().file_id;
  const stored = fs.readFileSync(path.join(h.ctx.config.uploadDir, 'files', fileId));
  assert.ok(stored.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), 'valid JPEG');
  assert.ok(!stored.includes('SAMPLE-GPS') && !stored.includes('Exif'), 'EXIF removed before upload');

  // Keyboard only: no mouse used to place the pin.
  await page.getByRole('button', { name: 'Add a pin' }).click();
  const cross = page.getByRole('group', { name: /Pin position marker/ });
  await cross.waitFor(); assert.ok(await cross.evaluate(e => e === document.activeElement), 'marker takes focus');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  assert.match(await page.locator('main .vh[role=status]').textContent(), /60 percent across, 56 percent down/, 'position is announced to screen readers');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'New pin' }).waitFor();
  assert.equal(await page.getByLabel('Across (%)').inputValue(), '60'); assert.equal(await page.getByLabel('Down (%)').inputValue(), '56');
  await page.getByLabel('What is it? (label)').fill('SAMPLE XLR input');
  await page.getByRole('button', { name: 'Save pin' }).click(); await page.getByText('Pin saved.').waitFor();
  const pin1 = page.getByRole('button', { name: /Pin 1: SAMPLE XLR input\. Source: Team/ }); await pin1.waitFor();
  assert.equal(await pin1.evaluate(e => e.style.left), '60%');

  // Second pin, keyboard again, Manufacturer-sourced (official domain required).
  await page.getByRole('button', { name: 'Add a pin' }).click(); await page.getByRole('group', { name: /Pin position marker/ }).waitFor();
  await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Enter');
  await page.getByLabel('What is it? (label)').fill('SAMPLE power inlet');
  await page.getByLabel('Where this came from').selectOption('manufacturer');
  await page.getByLabel(/Source URL/).fill('https://evil.example.org/x'); await page.getByRole('button', { name: 'Save pin' }).click();
  await page.getByText(/not on the admin-listed official domains/).waitFor();
  await page.getByLabel(/Source URL/).fill('https://support.example-maker.com/stagebox'); await page.getByRole('button', { name: 'Save pin' }).click();
  await page.getByRole('button', { name: /Pin 2: SAMPLE power inlet\. Source: Manufacturer/ }).waitFor();

  // An AI-labelled pin and a VERIFY pin exist but must not appear in Quiz me.
  await ac.post(`/api/panels/${h.db.prepare('SELECT id FROM photo_panels').get().id}/pins`, { x: 0.2, y: 0.2, provenance: 'ai', label: 'SAMPLE AI guess' });
  await ac.post(`/api/panels/${h.db.prepare('SELECT id FROM photo_panels').get().id}/pins`, { x: 0.8, y: 0.8, provenance: 'verify', label: '' });
  await page.reload(); await page.getByRole('heading', { name: 'SAMPLE rear panel' }).waitFor();
  await page.getByRole('button', { name: /Pin 1:/ }).click(); await page.getByRole('region', { name: 'Selected pin' }).getByText(/Team/).waitFor();
  await page.getByRole('button', { name: 'Quiz me' }).click();
  await page.getByText('Question 1 of 2').waitFor();             // only the 2 Manufacturer/Team pins
  assert.equal(await page.getByRole('button', { name: /AI guess/ }).count(), 0, 'AI pins are not quizzed');
  for (let i = 0; i < 2; i++) {
    const opts = await page.locator('.opt-btn').allTextContents();
    assert.ok(opts.length >= 2 && opts.every(o => !/AI guess/.test(o)));
    await page.locator('.opt-btn').first().click();
    await page.getByText(/Correct\.|Not quite/).waitFor(); await page.getByRole('button', { name: /Next|Finish/ }).click();
  }
  await page.getByText(/of 2\. This practice does not affect sign-off/).waitFor();
  await page.context().close();
});

test('documents: PDF upload from the UI downloads as an attachment; fake PDFs are refused', async () => {
  const page = await open('chief');
  await page.evaluate(id => { location.hash = '#/equipment/' + id; }, eq.id);
  await page.getByRole('heading', { name: 'Documents' }).waitFor();
  const good = path.join(dir, 'manual.pdf'); fs.writeFileSync(good, '%PDF-1.4\n%SAMPLE manual\n');
  await page.getByLabel('Choose a PDF').setInputFiles(good); await page.getByRole('button', { name: 'Upload PDF' }).click(); await page.getByText('Uploaded.').waitFor();
  const link = page.getByRole('link', { name: 'manual.pdf' }); await link.waitFor();
  const resp = await page.evaluate(async href => { const r = await fetch(href, { credentials: 'same-origin' }); return { s: r.status, d: r.headers.get('content-disposition'), t: r.headers.get('content-type') }; }, await link.getAttribute('href'));
  assert.equal(resp.s, 200); assert.match(resp.d, /^attachment/); assert.equal(resp.t, 'application/pdf');
  const fake = path.join(dir, 'fake.pdf'); fs.writeFileSync(fake, 'MZ not really a pdf');
  await page.getByLabel('Choose a PDF').setInputFiles(fake); await page.getByRole('button', { name: 'Upload PDF' }).click();
  await page.getByText(/isn't allowed for documents/).waitFor();
  await page.context().close();
});

test('lesson video: uploaded clip pauses at its checkpoint until answered; SharePoint embed is sandboxed and lists checkpoints', async () => {
  const trainer = await h.makeUser('trainer', 'coach'); const tc = await h.as(trainer);
  const tech = await h.makeUser('technician', 'tina');
  const m = (await tc.post('/api/modules', { title: 'SAMPLE video module', level: 1 })).body.module;
  const file = await (async () => { const c = h.client(); await c.login(trainer); return c.upload({ purpose: 'video' }, fs.readFileSync(webm), 'clip.webm', 'video/webm'); })();
  assert.equal(file.status, 201);
  const v = (await tc.post(`/api/modules/${m.id}/videos`, { title: 'SAMPLE uploaded clip', kind: 'upload', file_id: file.body.file.id })).body.id;
  await tc.post(`/api/videos/${v}/checkpoints`, { at_seconds: 2, prompt: 'SAMPLE: what moved?', options: ['Nothing', 'The test pattern'], correct_index: 1 });
  const sp = (await tc.post(`/api/modules/${m.id}/videos`, { title: 'SAMPLE SharePoint video', kind: 'sharepoint_embed', url: 'https://sample-tenant.sharepoint.com/_layouts/15/embed.aspx?uniqueId=SAMPLE' })).body.id;
  await tc.post(`/api/videos/${sp}/checkpoints`, { at_seconds: 90, prompt: 'SAMPLE embed question', options: ['A', 'B'], correct_index: 0 });

  const page = await open('tina');
  await page.getByRole('link', { name: 'Training' }).click(); await page.getByRole('link', { name: /SAMPLE video module/ }).click();
  await page.getByRole('heading', { name: 'Lesson videos' }).waitFor();
  const vid = page.locator('video.lesson'); await vid.waitFor();
  assert.ok(!(await page.content()).includes('correct_index'), 'answers not sent to learners');
  await vid.evaluate(async el => { el.muted = true; await el.play(); });
  await page.getByText('Checkpoint at 0:02: SAMPLE: what moved?').waitFor({ timeout: 20000 });
  const t = await vid.evaluate(el => ({ paused: el.paused, time: el.currentTime }));
  assert.equal(t.paused, true, 'video paused at the checkpoint'); assert.ok(t.time >= 2 && t.time < 5, `paused near 2s, was ${t.time}`);
  const cp = page.getByRole('group', { name: /Checkpoint at 0:02/ });
  await cp.getByLabel('Nothing').check(); await cp.getByRole('button', { name: 'Check answer' }).click(); await page.getByText(/Not quite\. The answer is: The test pattern/).waitFor();
  await cp.getByLabel('The test pattern').check(); await cp.getByRole('button', { name: 'Check answer' }).click(); await page.getByText('Correct.').waitFor();
  await page.getByRole('button', { name: 'Continue the video' }).click();
  await page.waitForFunction(() => { const e = document.querySelector('video.lesson'); return !e.paused && e.currentTime > 2.2; }, null, { timeout: 15000 });

  const frame = page.locator('iframe.video-frame');
  assert.match(await frame.getAttribute('sandbox'), /allow-scripts/); assert.ok(!/allow-top-navigation/.test(await frame.getAttribute('sandbox')));
  assert.match(await frame.getAttribute('src'), /^https:\/\/sample-tenant\.sharepoint\.com\//);
  await page.getByText('Checkpoint at 1:30: SAMPLE embed question').waitFor();
  await page.getByText(/can’t pause the video for you/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove video' }).count(), 0, 'technicians cannot manage videos');
  await page.context().close();
});

test('the sign-in page cannot be framed, and a SharePoint iframe is the only permitted frame source', async () => {
  const res = await fetch(h.base + '/'); const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /frame-src https:\/\/\*\.sharepoint\.com/); assert.match(csp, /media-src 'self' blob:/);
});

test('mobile: panel, equipment and training-video screens keep 44px targets, labels and no sideways scroll', async () => {
  const panelId = h.db.prepare('SELECT id FROM photo_panels').get().id, mod = h.db.prepare("SELECT id FROM training_modules WHERE title='SAMPLE video module'").get().id;
  const page = await open('chief', { width: 390, height: 844 });
  for (const hash of [`#/panels/${panelId}`, `#/equipment/${eq.id}`, `#/training/${mod}`]) {
    await page.evaluate(x => { location.hash = x; }, hash); await page.getByRole('heading', { level: 1 }).first().waitFor(); await page.waitForTimeout(600);
    const bad = await page.evaluate(() => ({
      small: [...document.querySelectorAll('button,a.btn,nav a,select,summary,input:not([type=file]):not([type=checkbox]):not([type=radio])')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 43.5 && !e.closest('video')).map(e => e.tagName + ':' + (e.getAttribute('aria-label') || e.textContent).slice(0, 30)),
      unlabeled: [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(e => e.offsetParent !== null && !e.labels?.length && !e.getAttribute('aria-label')).length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
    assert.deepEqual(bad.small, [], `small targets on ${hash}`); assert.equal(bad.unlabeled, 0, `unlabelled controls on ${hash}`); assert.equal(bad.overflow, false, `sideways scroll on ${hash}`);
  }
  await page.context().close();
});
