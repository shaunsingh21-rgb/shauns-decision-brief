'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const { harness, PW } = require('../helpers');

const fakeFetch = async u => String(u).includes('brave.com')
  ? { ok: true, json: async () => ({ web: { results: [{ title: 'SAMPLE official page', url: 'https://support.example-maker.com/mx100', description: 'SAMPLE snippet about the mixer' }] } }) }
  : { ok: true, json: async () => ({ content: [{ text: '{"summary":"SAMPLE: a small mixer.","unknown":["power rating"]}' }] }) };

let h, browser, errors = [], dir;
before(async () => {
  h = await harness({ fetchImpl: fakeFetch, braveApiKey: 'k1', anthropicApiKey: 'k2' });
  browser = await chromium.launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-e2e-'));
});
after(async () => { await browser?.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function newPage(viewport = { width: 1000, height: 800 }) {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return page;
}
async function signIn(page, username, password = PW) {
  await page.goto(h.base + '/'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('first login forces a new password, then the app opens (no demo/role switcher anywhere)', async () => {
  await h.makeUser('admin', 'boss', { mustChange: true });
  const page = await newPage(); await signIn(page, 'boss');
  await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
  await page.getByLabel('Current (temporary) password').fill(PW); await page.getByLabel('New password', { exact: true }).fill('A-fresh-passphrase-42'); await page.getByLabel('Repeat new password').fill('A-fresh-passphrase-42');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  assert.equal(await page.getByText(/demo user/i).count(), 0);
  assert.equal(await page.locator('select[aria-label*="role" i]').count(), 0);
  await page.context().close();
});

test('wizard: photo -> OCR -> confirm -> research -> AI draft -> review -> save; VERIFY override on approval', async () => {
  const admin = await h.makeUser('admin', 'chief');
  await h.as(admin).then(c => c.post('/api/sources', { domain: 'example-maker.com' }));
  // Make a label image with real text so OCR has something to read.
  const p0 = await newPage(); await p0.goto('about:blank');
  const dataUrl = await p0.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 260; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 260); x.fillStyle = '#000'; x.font = 'bold 72px Arial'; x.fillText('SAMPLE MIXER MX100', 30, 150); return c.toDataURL('image/png'); });
  const img = path.join(dir, 'label.png'); fs.writeFileSync(img, Buffer.from(dataUrl.split(',')[1], 'base64')); await p0.context().close();

  const page = await newPage(); await signIn(page, 'chief');
  await page.getByRole('link', { name: 'Add equipment' }).click();
  await page.locator('input[type=file]').first().setInputFiles(img);
  await page.getByText(/Done\. Check the text|not available here|No text found/).waitFor({ timeout: 90000 });
  const ocrText = await page.getByLabel(/Text from the label/).inputValue();
  console.log('    OCR read:', JSON.stringify(ocrText));
  assert.match(ocrText.toUpperCase(), /MIXER|MX/, 'OCR should read part of the label');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Equipment name / model').fill('SAMPLE Mixer MX100'); await page.getByLabel('Manufacturer').fill('SAMPLE Co');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Search official sources' }).click();
  await page.getByText('SAMPLE official page').waitFor();
  await page.getByLabel('Item name').fill('rack'); await page.getByLabel('Value as written on the page').fill('SAMPLE 2U');
  await page.getByRole('button', { name: 'Add as Manufacturer item' }).click();
  await page.getByRole('button', { name: 'Draft a description with AI' }).click();
  await page.getByText('AI-drafted — not verified.').waitFor();
  await page.getByRole('button', { name: 'Add to review list' }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  for (const c of ['b-manufacturer', 'b-ai', 'b-verify']) assert.ok(await page.locator(`.badge.${c}`).first().isVisible(), `${c} badge shown in review`);
  await page.getByRole('button', { name: 'Save and submit for review' }).click();
  await page.getByRole('heading', { name: 'SAMPLE Mixer MX100' }).waitFor();
  await page.getByText('Needs Review').first().waitFor();

  // Approval with VERIFY items needs an explicit override + reason.
  await page.getByRole('button', { name: 'Approve anyway (override)' }).click();
  await page.getByText(/Override reason|reason/i).first().waitFor();
  assert.ok((await page.locator('.toast').allTextContents()).join().match(/reason/i), 'override without reason is refused');
  await page.getByLabel(/Override reason/).fill('SAMPLE: spec sheet pending');
  await page.getByRole('button', { name: 'Approve anyway (override)' }).click();
  await page.getByText('Approved', { exact: true }).first().waitFor();
  await page.context().close();
});

test('training: technician takes quiz; trainer scores + signs off; trainer cannot sign off self; viewer is read-only', async () => {
  const trainer = await h.makeUser('trainer', 'coach'), tech = await h.makeUser('technician', 'tina'), viewer = await h.makeUser('viewer', 'vic');
  const tc = await h.as(trainer);
  const m = (await tc.post('/api/modules', { title: 'SAMPLE: Level 1 basics', level: 1, summary: 'SAMPLE module' })).body.module;
  for (let i = 0; i < 5; i++) await tc.post(`/api/modules/${m.id}/questions`, { prompt: `SAMPLE question ${i + 1}`, options: ['Wrong', 'Right'], correct_index: 1 });
  await tc.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE skill' });
  const draftPage = await newPage(); await signIn(draftPage, 'coach');                                                  // a Draft module cannot be signed off, and the screen says so
  await draftPage.getByRole('link', { name: 'Training' }).click(); await draftPage.getByRole('link', { name: /SAMPLE: Level 1 basics/ }).click();
  await draftPage.getByRole('heading', { name: 'Trainer: score and sign off' }).waitFor(); await draftPage.getByLabel('Trainee').selectOption({ label: 'Sample tina' });
  await draftPage.getByText('This module must be approved before anyone can be signed off on it.').waitFor(); assert.equal(await draftPage.getByRole('button', { name: 'Sign off this trainee' }).count(), 0); await draftPage.context().close();
  await (await h.as(await h.makeUser('admin', 'approver'))).post(`/api/modules/${m.id}/approve`);

  const tp = await newPage(); await signIn(tp, 'tina');
  await tp.getByRole('link', { name: 'Training' }).click(); await tp.getByRole('link', { name: /SAMPLE: Level 1 basics/ }).click();
  await tp.getByRole('heading', { name: 'Written quiz' }).waitFor();
  for (const g of await tp.locator('fieldset').all()) await g.getByLabel('Right').check();
  await tp.getByRole('button', { name: 'Submit answers' }).click(); await tp.getByText(/100%\. Passed/).waitFor();
  assert.equal(await tp.getByRole('button', { name: 'Sign off this trainee' }).count(), 0, 'technician has no sign-off control');
  await tp.context().close();

  const cp = await newPage(); await signIn(cp, 'coach');
  await cp.getByRole('link', { name: 'Training' }).click(); await cp.getByRole('link', { name: /SAMPLE: Level 1 basics/ }).click(); await cp.getByRole('heading', { name: 'Written quiz' }).waitFor();
  assert.equal(await cp.getByLabel('Trainee').locator('option', { hasText: /coach/ }).count(), 0, 'trainer cannot pick themselves');
  await cp.getByLabel('Trainee').selectOption({ label: 'Sample tina' });
  await cp.getByRole('button', { name: 'Sign off this trainee' }).click();
  await cp.getByText(/Sign-off requirements are not met/).waitFor(); await cp.getByText(/Practical: "SAMPLE skill" is unscored/).waitFor();
  await cp.getByLabel('Score for SAMPLE skill').selectOption('2'); await cp.getByRole('button', { name: 'Save score' }).click();
  await cp.getByText('Score saved.').waitFor();
  await cp.getByLabel('Trainee').selectOption({ label: 'Sample tina' });
  await cp.getByRole('button', { name: 'Sign off this trainee' }).click(); await cp.getByText('Signed off.').first().waitFor();
  await cp.context().close();

  const vp = await newPage(); await signIn(vp, 'vic');
  await vp.getByRole('heading', { name: 'Equipment library' }).waitFor();
  assert.equal(await vp.getByRole('link', { name: 'Add equipment' }).count(), 0);
  assert.equal(await vp.getByRole('link', { name: 'Admin', exact: true }).count(), 0);
  await vp.context().close();
});

test('every screen renders for an admin; installation assistant progress persists; updates screen never offers auto-install', async () => {
  const admin = await h.makeUser('admin', 'tour'); const ac = await h.as(admin);
  const e = (await ac.post('/api/equipment', { name: 'SAMPLE Projector', fields: [{ key: 'note', provenance: 'team', value: 'SAMPLE' }] })).body.equipment;
  await ac.put(`/api/equipment/${e.id}/install-steps`, { steps: [{ text: 'SAMPLE step one', provenance: 'team' }, { text: 'SAMPLE step two', provenance: 'ai' }] });
  await ac.post('/api/updates', { equipment_id: e.id, kind: 'firmware', available_version: 'SAMPLE-v0' });
  await ac.post('/api/issues', { kind: 'lesson', title: 'SAMPLE lesson <b>bold?</b>', body: '<script>window.__xss=1</script>' });
  const page = await newPage(); await signIn(page, 'tour');
  for (const [hash, heading] of [['#/equipment', 'Equipment library'], ['#/training', 'Training'], ['#/updates', 'Update management'], ['#/issues', 'Issues & lessons learned'], ['#/matrix', 'Skill matrix'], ['#/admin', 'Admin']]) {
    await page.evaluate(x => { location.hash = x; }, hash);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(await page.locator('.notice.bad').count(), 0, hash);
    const text = await page.locator('#app').innerText();
    assert.ok(!/(^|\s)(false|true|undefined|null|NaN)(\s|$)|\[object /.test(text), `stray programming values shown on ${hash}: ${(text.match(/.{0,20}(\bfalse\b|\[object|undefined|\bNaN\b).{0,20}/) || [''])[0]}`);
  }
  await page.evaluate(() => { location.hash = '#/updates'; }); await page.getByText('Nothing is ever installed automatically').waitFor();
  assert.equal(await page.getByRole('button', { name: /^(install|update now|apply)/i }).count(), 0);
  // Hostile text is shown as text, never executed.
  await page.evaluate(() => { location.hash = '#/issues'; }); await page.getByText('SAMPLE lesson <b>bold?</b>').waitFor();
  assert.equal(await page.evaluate(() => window.__xss), undefined); assert.equal(await page.locator('main b').count(), 0);
  await page.evaluate(id => { location.hash = '#/equipment/' + id; }, e.id);
  await page.getByRole('heading', { name: 'Installation assistant' }).waitFor();
  await page.getByLabel(/1\. SAMPLE step one/).check(); await page.getByText('1 of 2 done').waitFor();
  await page.reload(); await page.getByRole('heading', { name: 'Installation assistant' }).waitFor();
  assert.ok(await page.getByLabel(/1\. SAMPLE step one/).isChecked(), 'progress saved to the account');
  assert.ok(await page.locator('.badge.b-ai').first().isVisible(), 'AI-drafted step is labelled');
  await page.context().close();
});

test('mobile layout: 44px touch targets on key screens, no horizontal page scroll, labelled controls', async () => {
  await h.makeUser('admin', 'mobi');
  const page = await newPage({ width: 390, height: 844 }); await signIn(page, 'mobi');
  await page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  for (const hash of ['#/equipment', '#/training', '#/equipment/new', '#/admin', '#/issues']) {
    await page.evaluate(x => { location.hash = x; }, hash); await page.waitForTimeout(400);
    const small = await page.evaluate(() => [...document.querySelectorAll('button,a.btn,nav a,select,input:not([type=file]):not([type=checkbox]):not([type=radio]),summary')]
      .filter(e => e.offsetParent && (e.getBoundingClientRect().height < 43.5)).map(e => e.tagName + ':' + (e.textContent || e.getAttribute('aria-label') || '').slice(0, 30)));
    assert.deepEqual(small, [], `small targets on ${hash}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal scroll on ${hash}`);
    const unlabeled = await page.evaluate(() => [...document.querySelectorAll('input:not([type=file]):not([type=hidden]),select,textarea')].filter(e => e.offsetParent && !e.labels?.length && !e.getAttribute('aria-label')).length);
    assert.equal(unlabeled, 0, `unlabelled controls on ${hash}`);
  }
  await page.context().close();
});

test('dark mode and reduced motion are honoured; no CSP violations or JS errors occurred', async () => {
  await h.makeUser('viewer', 'dark');
  const ctx = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' }); const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await signIn(page, 'dark'); await page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(bg, 'rgb(245, 247, 244)', 'dark theme applied');
  await ctx.close();
  assert.deepEqual(errors.filter(e => !/401|403|409|400|429|503/.test(e)), [], 'no unexpected console/page errors (CSP violations show here)');
});
