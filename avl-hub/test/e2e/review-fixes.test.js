'use strict';
// Browser reproductions of the problems found by the pre-launch review team. Each one failed before the fix.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { harness, PW } = require('../helpers');

let h, browser;
before(async () => { h = await harness({ quizAttemptsPerHour: 3 }); browser = await chromium.launch(); await h.makeUser('admin', 'boss'); });
after(async () => { await browser?.close(); await h.close(); });

async function open(username, { ctx, viewport = { width: 1000, height: 800 } } = {}) {
  const context = ctx || await browser.newContext({ viewport }); const page = await context.newPage();
  await page.goto(h.base + '/'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(PW); await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Equipment library' }).waitFor(); return { page, context };
}
const idb = (page, store) => page.evaluate(s => new Promise(res => { const r = indexedDB.open('avl-hub'); r.onsuccess = () => { const q = r.result.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); }; }), store);
const count = (sql, ...a) => h.db.prepare(sql).get(...a).n;
const offlineTab = async page => { await page.route('**/api/**', r => r.abort()); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); };
const onlineTab = async page => { await page.unroute('**/api/**'); await page.evaluate(() => window.dispatchEvent(new Event('online'))); };

test('double-tapping a save button creates ONE thing, not two (slow network)', async () => {
  const u = await h.makeUser('technician', 'dbl'); const { page, context } = await open('dbl');
  await page.route('**/api/issues', async r => { if (r.request().method() === 'POST') await new Promise(x => setTimeout(x, 500)); r.continue(); });
  await page.getByRole('link', { name: 'Issues & lessons' }).click(); await page.getByRole('heading', { name: /Issues/ }).waitFor();
  await page.getByText('Log an issue or lesson').click(); await page.getByLabel('Title').fill('SAMPLE double tap');
  const before = count("SELECT COUNT(*) n FROM issues WHERE title='SAMPLE double tap'"); await page.getByRole('button', { name: 'Save', exact: true }).dblclick();
  await page.getByText('Logged.').waitFor(); assert.equal(count("SELECT COUNT(*) n FROM issues WHERE title='SAMPLE double tap'") - before, 1, 'exactly one issue');
  const tc = await h.as(await h.makeUser('trainer', 'dbltrainer')); void tc; void u; await context.close();
});

test('a background sync finishing never wipes a form you are typing in', async () => {
  const ac = await h.as(await h.makeUser('admin', 'typist')); const e = (await ac.post('/api/equipment', { name: 'SAMPLE typing', fields: [] })).body.equipment;
  const { page, context } = await open('typist'); await page.evaluate(id => { location.hash = '#/equipment/' + id; }, e.id); await page.getByRole('heading', { name: 'SAMPLE typing' }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('SAMPLE typing — half-finished edit');
  await page.getByRole('button', { name: 'Add as VERIFY' }).focus();                                  // focus is on a BUTTON (the old check only protected text boxes)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('avl:synced')));
  await page.getByText('Your changes were saved. Reload this page to see the latest.').waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'SAMPLE typing — half-finished edit', 'the form is still there, untouched');
  await context.close();
});

test('roles that cannot do something are not shown a way to try (wizard, checkpoint answers)', async () => {
  const tc = await h.as(await h.makeUser('trainer', 'gater')); const m = (await tc.post('/api/modules', { title: 'SAMPLE gated', level: 1 })).body.module;
  const v = (await tc.post(`/api/modules/${m.id}/videos`, { title: 'SAMPLE video', kind: 'link', url: 'https://example.com/v' })).body.id;
  await tc.post(`/api/videos/${v}/checkpoints`, { at_seconds: 5, prompt: 'SAMPLE cp', options: ['a', 'b'], correct_index: 0 });
  await h.makeUser('viewer', 'looker'); const { page, context } = await open('looker');
  await page.evaluate(() => { location.hash = '#/equipment/new'; }); await page.getByText('Your role can’t add equipment.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Next' }).count(), 0, 'no wizard to fill in');
  await page.evaluate(id => { location.hash = '#/training/' + id; }, m.id); await page.getByText('Checkpoint at 0:05').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check answer' }).count(), 0); await page.getByText('Your role can’t answer checkpoints.').waitFor(); await context.close();
});

test('long unbroken text (a pasted link) does not stretch the page on a phone', async () => {
  const kc = await h.as(await h.makeUser('technician', 'longtext')); await kc.post('/api/issues', { kind: 'issue', title: 'SAMPLE long link', body: 'https://example.sharepoint.com/' + 'a'.repeat(300) });
  await kc.post('/api/equipment', { name: 'SAMPLE', manufacturer: 'M'.repeat(120), fields: [] });
  const { page, context } = await open('longtext', { viewport: { width: 390, height: 844 } });
  for (const hash of ['#/issues', '#/equipment']) { await page.evaluate(x => { location.hash = x; }, hash); await page.waitForTimeout(500); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll on ${hash}`); }
  await context.close();
});

test('phone header is compact and stays put; the account link lives in the navigation row; titles, skip link and focus behave', async () => {
  await h.makeUser('technician', 'phonehdr'); const { page, context } = await open('phonehdr', { viewport: { width: 390, height: 844 } });
  const box = await page.locator('header.top').boundingBox(); assert.ok(box.height < 150, `header is ${box.height}px tall (was ~250)`);
  assert.equal(await page.locator('.hdr-user').first().isVisible(), false, 'name and sign-out are not crowding the header'); assert.equal(await page.getByRole('link', { name: 'Account', exact: true }).isVisible(), true);
  await page.evaluate(() => { document.getElementById('app').style.minHeight = '3000px'; window.scrollTo(0, 800); }); assert.equal(Math.round((await page.locator('header.top').boundingBox()).y), 0, 'header stays at the top while scrolling');
  await page.getByRole('link', { name: 'Training', exact: true }).click(); await page.getByRole('heading', { name: 'Training', exact: true }).waitFor(); assert.equal(await page.title(), 'Training – AVL Tech Hub');
  await page.evaluate(() => { location.hash = '#/account'; }); await page.getByRole('heading', { name: 'My account' }).waitFor(); assert.equal(await page.title(), 'My account – AVL Tech Hub');
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByLabel('Username').waitFor();
  assert.equal(await page.locator('main#main').count(), 1, 'the sign-in page has a main landmark');
  await context.close();
  const d = await open('phonehdr'); await d.page.evaluate(() => { location.hash = '#/training'; }); await d.page.getByRole('heading', { name: 'Training', exact: true }).waitFor();
  await d.page.locator('.skip').focus(); await d.page.keyboard.press('Enter'); assert.match(d.page.url(), /#\/training$/, 'the skip link did not change the page'); assert.equal(await d.page.evaluate(() => document.activeElement.id), 'main');
  await d.context.close();
  const w = await open('phonehdr'); await w.page.getByRole('link', { name: 'Add equipment' }).count().then(() => {}); await w.context.close();
});

test('TWO TABS, TWO PEOPLE: a change queued as one person is never sent as the other, and the other person signing in and out never wipes it', async () => {
  const alice = await h.makeUser('technician', 'alice2'), bob = await h.makeUser('technician', 'bob2');
  const { page: p1, context } = await open('alice2');
  await p1.getByRole('link', { name: 'Issues & lessons' }).click(); await p1.getByRole('heading', { name: /Issues/ }).waitFor(); await p1.getByText('Log an issue or lesson').waitFor();
  await offlineTab(p1);                                                                               // alice's tab loses the network
  await p1.getByText('Log an issue or lesson').click(); await p1.getByLabel('Title').fill('SAMPLE queued by alice'); await p1.getByRole('button', { name: 'Save', exact: true }).click();
  await p1.getByText(/Saved on this device/).waitFor(); assert.equal((await idb(p1, 'outbox')).filter(o => o.userId === alice.id).length, 1);
  // alice's session ends (as if it expired) and bob signs in, in ANOTHER tab of the same browser
  await context.clearCookies(); const p2 = await context.newPage(); await p2.goto(h.base + '/'); await p2.getByLabel('Username').fill('bob2'); await p2.getByLabel('Password').fill(PW); await p2.getByRole('button', { name: 'Sign in' }).click();
  await p2.getByRole('heading', { name: 'Equipment library' }).waitFor();
  await onlineTab(p1);                                                                                // alice's tab gets its network back and tries to send her change
  await p1.getByText('Someone else signed in on this browser.').waitFor({ timeout: 15000 });
  assert.equal(count("SELECT COUNT(*) n FROM issues WHERE title='SAMPLE queued by alice'"), 0, 'NOT created under bob\'s session');
  assert.equal(count('SELECT COUNT(*) n FROM issues WHERE created_by=?', bob.id), 0);
  await p1.locator('header.top').getByText(/Sample bob2/).waitFor(); assert.match(await p1.locator('header.top').innerText(), /Sample bob2/, 'the old tab now shows the person who is actually signed in');
  await p2.locator('header.top').getByRole('button', { name: 'Sign out' }).click(); await p2.getByLabel('Username').waitFor();             // bob signs out…
  assert.equal((await idb(p2, 'outbox')).filter(o => o.userId === alice.id).length, 1, '…and alice\'s unsynced change is still on this device (the old code erased it)');
  await context.close();
});

test('a change you discarded in one tab is not sent by another tab', async () => {
  await h.makeUser('technician', 'discarder'); const { page: p1, context } = await open('discarder');
  await p1.getByRole('link', { name: 'Issues & lessons' }).click(); await p1.getByRole('heading', { name: /Issues/ }).waitFor(); await p1.getByText('Log an issue or lesson').waitFor();
  await offlineTab(p1); await p1.getByText('Log an issue or lesson').click(); await p1.getByLabel('Title').fill('SAMPLE discard me'); await p1.getByRole('button', { name: 'Save', exact: true }).click(); await p1.getByText(/Saved on this device/).waitFor();
  const p2 = await context.newPage(); await offlineTab(p2); await p2.goto(h.base + '/#/sync'); await p2.getByText('Log “SAMPLE discard me”').waitFor();      // the second tab has loaded the waiting change too
  await p1.evaluate(() => { location.hash = '#/sync'; }); await p1.getByText('Log “SAMPLE discard me”').waitFor(); p1.once('dialog', d => d.accept()); await p1.getByRole('button', { name: 'Discard' }).click(); await p1.getByText('Discarded.').waitFor();
  await onlineTab(p2); await onlineTab(p1); await p2.waitForTimeout(3000); await p2.evaluate(() => window.dispatchEvent(new Event('online'))); await p2.waitForTimeout(2500);
  assert.equal(count("SELECT COUNT(*) n FROM issues WHERE title='SAMPLE discard me'"), 0, 'the discarded change never reached the server'); await context.close();
});

test('signing out while OFFLINE still ends the server session once the connection returns', async () => {
  await h.makeUser('technician', 'offlineout'); const { page, context } = await open('offlineout');
  const cookie = (await context.cookies()).find(c => c.name === 'avl_sid').value;
  await context.setOffline(true); await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByText(/You are offline. You are signed out on this device/).waitFor(); await page.getByLabel('Username').waitFor();
  await context.setOffline(false); await page.reload(); await page.getByLabel('Username').waitFor();                 // NOT signed back in
  const r = await fetch(h.base + '/api/me', { headers: { cookie: 'avl_sid=' + cookie } }); assert.equal(r.status, 401, 'the old server session is gone');
  await context.close();
});

test('the background prefetch is gentle: about one request per item, no 429s, and not repeated on every screen', async () => {
  const ac = await h.as(await h.makeUser('admin', 'bulk')); const ids = []; for (let i = 0; i < 30; i++) ids.push((await ac.post('/api/equipment', { id: crypto.randomUUID(), name: `SAMPLE bulk ${i}`, fields: [] })).body.equipment.id);
  const ctx = await browser.newContext(); const page = await ctx.newPage(); const calls = []; const bad = []; page.on('request', r => { if (r.url().includes('/api/')) calls.push(r.url()); }); page.on('response', r => { if (r.status() === 429) bad.push(r.url()); });
  await page.goto(h.base + '/'); await page.getByLabel('Username').fill('bulk'); await page.getByLabel('Password').fill(PW); await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  await page.waitForTimeout(9000);
  const perItem = ids.map(id => calls.filter(u => u.endsWith('/api/equipment/' + id)).length); assert.ok(Math.max(...perItem) <= 1, `each item fetched at most once (got up to ${Math.max(...perItem)})`);
  const afterWarm = calls.length; for (const l of ['Training', 'Issues & lessons', 'Updates', 'Equipment', 'Training', 'Equipment']) { await page.getByRole('link', { name: l, exact: true }).click(); await page.waitForTimeout(250); }
  assert.ok(calls.length - afterWarm < 40, `navigating does not trigger another prefetch (${calls.length - afterWarm} new calls)`); assert.deepEqual(bad, [], 'no "too many requests" responses'); await ctx.close();
});

test('the sync status clears by itself soon after the connection returns (no reload needed)', async () => {
  await h.makeUser('technician', 'pill'); const { page, context } = await open('pill'); await page.getByRole('link', { name: 'Issues & lessons' }).click(); await page.getByRole('heading', { name: /Issues/ }).waitFor(); await page.getByText('Log an issue or lesson').waitFor();
  await context.setOffline(true); await page.getByText('Log an issue or lesson').click(); await page.getByLabel('Title').fill('SAMPLE pill'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText(/Saved on this device/).waitFor();
  await page.locator('.syncline', { hasText: /Offline — 1 change waiting/ }).waitFor(); await context.setOffline(false);          // NO "online" event is sent: the app must notice on its own
  await page.locator('.syncline', { hasText: 'All changes saved' }).waitFor({ timeout: 20000 }); assert.equal(count("SELECT COUNT(*) n FROM issues WHERE title='SAMPLE pill'"), 1); await context.close();
});

test('pins: a tap shows where the pin will go and moves to the form; the selected pin is highlighted; each pin shows its source as a letter', async () => {
  const ac = await h.as(await h.makeUser('admin', 'pinner')); const e = (await ac.post('/api/equipment', { name: 'SAMPLE pin target', fields: [] })).body.equipment;
  const tmpPng = path.join(os.tmpdir(), `avl-pin-${process.pid}.png`); assert.equal(spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=600x400:rate=1', '-frames:v', '1', tmpPng], { stdio: 'pipe' }).status, 0); const png = fs.readFileSync(tmpPng); fs.rmSync(tmpPng);
  const f = (await ac.upload({ purpose: 'photo' }, png, 'p.png')).body.file; const panel = (await ac.post('/api/panels', { equipment_id: e.id, title: 'SAMPLE panel', file_id: f.id })).body.panel;
  await ac.post(`/api/panels/${panel.id}/pins`, { x: 0.3, y: 0.3, provenance: 'manufacturer', label: 'SAMPLE M', source_url: 'https://x.example.com' }).catch(() => {});
  await ac.post('/api/sources', { domain: 'example.com' }); await ac.post(`/api/panels/${panel.id}/pins`, { x: 0.3, y: 0.3, provenance: 'manufacturer', label: 'SAMPLE M', source_url: 'https://support.example.com/x' }); await ac.post(`/api/panels/${panel.id}/pins`, { x: 0.6, y: 0.6, provenance: 'verify', label: '' });
  const { page, context } = await open('pinner', { viewport: { width: 390, height: 844 } }); await page.evaluate(id => { location.hash = '#/panels/' + id; }, panel.id); await page.getByRole('heading', { name: 'SAMPLE panel' }).waitFor();
  assert.deepEqual((await page.locator('.pin .src').allTextContents()).sort(), ['?', 'M']);
  await page.getByRole('button', { name: /^Pin 1:/ }).click(); await page.locator('.pin.active').waitFor(); assert.match(await page.locator('[role=region][aria-label="Selected pin"] h2').textContent(), /Pin 1: SAMPLE M/);
  const detailY = (await page.locator('[role=region][aria-label="Selected pin"]').boundingBox()).y, actionsY = (await page.getByRole('button', { name: 'Add a pin' }).boundingBox()).y; assert.ok(detailY < actionsY, 'the selected pin\'s details come before the action buttons');
  await page.getByRole('button', { name: 'Add a pin' }).click(); await page.getByText('Tap the photo where the pin goes.').waitFor();
  const box = await page.locator('.stage img').boundingBox(); await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await page.getByRole('heading', { name: 'New pin' }).waitFor(); await page.locator('.cross.static').waitFor(); assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT', 'focus moved to the first field of the form');
  assert.ok((await page.locator('form.card').boundingBox()).y < 844, 'the form is on screen, not below the fold');
  await page.getByLabel('What is it? (label)').fill('SAMPLE kept label'); await page.getByLabel('Where this came from').selectOption('verify'); assert.equal(await page.getByLabel('What is it? (label)').inputValue(), '');
  await page.getByLabel('Where this came from').selectOption('team'); assert.equal(await page.getByLabel('What is it? (label)').inputValue(), 'SAMPLE kept label', 'switching back restores what was typed'); await context.close();
});

test('quizzes: blanks are caught before sending, the result shows above the button, "best" updates, and the attempt limit is explained', async () => {
  const tc = await h.as(await h.makeUser('trainer', 'quizauthor')); const m = (await tc.post('/api/modules', { title: 'SAMPLE quiz UI', level: 1 })).body.module;
  for (let i = 0; i < 2; i++) await tc.post(`/api/modules/${m.id}/questions`, { prompt: `SAMPLE Q${i + 1}`, options: ['Wrong', 'Right'], correct_index: 1 });
  await tc.post(`/api/modules/${m.id}/skills`, { name: 'S' }); await (await h.as(await h.makeUser('admin', 'quizadmin'))).post(`/api/modules/${m.id}/approve`);
  await h.makeUser('technician', 'quiztaker'); const { page, context } = await open('quiztaker'); await page.evaluate(id => { location.hash = '#/training/' + id; }, m.id); await page.getByRole('heading', { name: 'Written quiz' }).waitFor();
  await page.getByRole('button', { name: 'Submit answers' }).click(); await page.getByText('Answer every question first (2 ones are still blank).').waitFor(); assert.equal(count("SELECT COUNT(*) n FROM quiz_attempts"), 0, 'a blank attempt was not even sent');
  const fs = await page.locator('fieldset').all(); await fs[0].getByLabel('Wrong').check(); await fs[1].getByLabel('Wrong').check(); await page.getByRole('button', { name: 'Submit answers' }).click(); await page.getByText(/Score 0%\. You need 80% to pass\./).waitFor();
  await fs[0].getByLabel('Right').check(); await fs[1].getByLabel('Right').check(); await page.getByRole('button', { name: 'Submit answers' }).click(); await page.getByText('Score 100%. Passed.').waitFor(); await page.getByText('Your best: 100%.').waitFor();
  const res = await page.locator('[role=status][aria-live=polite]').first().boundingBox(), btn = await page.getByRole('button', { name: 'Submit answers' }).boundingBox(); assert.ok(res.y < btn.y, 'the result appears above the button');
  await page.getByRole('button', { name: 'Submit answers' }).click(); await page.getByRole('button', { name: 'Submit answers' }).click().catch(() => {});
  await page.getByText(/You have used 3 attempts on this quiz in the last hour\./).waitFor(); await context.close();
});

test('SIGN-OFF RECORD: who and when show to the trainee; a changed module shows as out of date and can be renewed with a note', async () => {
  const tc = await h.as(await h.makeUser('trainer', 'coach9')), ac = await h.as(await h.makeUser('admin', 'adm9')); const trainee = await h.makeUser('technician', 'trainee9'); const kc = await h.as(trainee);
  const m = (await tc.post('/api/modules', { title: 'SAMPLE renewal', level: 1 })).body.module; const q = (await tc.post(`/api/modules/${m.id}/questions`, { prompt: 'Q', options: ['a', 'b'], correct_index: 1 })).body.id; const sk = (await tc.post(`/api/modules/${m.id}/skills`, { name: 'Skill A' })).body.id;
  await ac.post(`/api/modules/${m.id}/approve`); await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: { [q]: 1 } }); await tc.post('/api/practical-scores', { trainee_id: trainee.id, skill_id: sk, score: 3 });
  const t2 = await h.as(await h.makeUser('trainer', 'coach9b')); await t2.post('/api/signoffs', { trainee_id: trainee.id, module_id: m.id, note: 'SAMPLE note' });
  const tp = await open('trainee9'); await tp.page.evaluate(id => { location.hash = '#/training/' + id; }, m.id); await tp.page.getByText(/Signed off by Sample coach9b on /).waitFor();
  await tc.post(`/api/modules/${m.id}/skills`, { name: 'Skill B' }); await ac.post(`/api/modules/${m.id}/approve`); const sb = (await tc.get(`/api/modules/${m.id}`)).body.module.skills.find(s => s.name === 'Skill B').id; await tc.post('/api/practical-scores', { trainee_id: trainee.id, skill_id: sb, score: 2 });
  await tp.page.reload(); await tp.page.getByText(/but this material has changed since\. Ask a trainer to renew your sign-off\./).waitFor(); await tp.context.close();
  const cp = await open('coach9b'); await cp.page.evaluate(id => { location.hash = '#/training/' + id; }, m.id); await cp.page.getByRole('heading', { name: 'Trainer: score and sign off' }).waitFor();
  await cp.page.getByLabel('Trainee').selectOption({ label: 'Sample trainee9' }); await cp.page.getByText(/signed off on an earlier version/).waitFor(); await cp.page.getByLabel('Note for the record (optional)').fill('SAMPLE renewal note');
  await cp.page.getByRole('button', { name: 'Renew the sign-off' }).click(); await cp.page.getByText('Signed off.').first().waitFor({ timeout: 8000 }).catch(() => {});
  assert.equal(count('SELECT COUNT(*) n FROM signoffs WHERE trainee_id=? AND module_id=?', trainee.id, m.id), 2, 'history kept: two sign-offs on record'); assert.equal(h.db.prepare("SELECT note FROM signoffs WHERE trainee_id=? ORDER BY rowid DESC").get(trainee.id).note, 'SAMPLE renewal note'); await cp.context.close();
});

test('the Admin screen on a phone: readable people cards, who is locked out, last sign-in, plain-language audit log, backup status', async () => {
  const lh = await h.makeUser('technician', 'lockme'); const ac = await h.as(await h.makeUser('admin', 'adminphone')); void lh;
  for (let i = 0; i < 6; i++) await h.client().login('lockme', 'wrong-password-12');
  for (let i = 0; i < 60; i++) h.db.prepare("INSERT INTO audit_log (ts,actor_name,action,entity) VALUES (?,?,?,?)").run(new Date().toISOString(), 'filler', 'auth.login', 'user');
  const { page, context } = await open('adminphone', { viewport: { width: 390, height: 844 } }); await page.getByRole('link', { name: 'Admin', exact: true }).click(); await page.getByRole('heading', { name: 'People' }).waitFor();
  const row = page.locator('tr', { hasText: 'lockme' }); await row.getByText(/Locked out for about \d+ more minute/).waitFor(); await row.getByRole('button', { name: 'Unlock now' }).waitFor();
  const other = page.locator('tr', { hasText: 'adminphone' }); assert.equal(await other.getByRole('button', { name: 'Unlock now' }).count(), 0, 'Unlock is only offered where it applies'); await other.locator('td[data-label="Last signed in"]').filter({ hasNotText: 'Never' }).waitFor(); assert.match(await row.locator('td[data-label="Last signed in"]').innerText(), /Never/, 'someone who never signed in says so');
  const sel = row.getByLabel('Role for lockme'); assert.ok((await sel.boundingBox()).width >= 150, 'the role dropdown shows the role name (it used to be squeezed to an arrow)');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
  await page.getByText('No backups found.').waitFor();
  await page.getByText('Signed in', { exact: true }).first().waitFor(); assert.equal(await page.getByText('auth.login', { exact: true }).count(), 0, 'no raw codes shown');
  await page.getByRole('button', { name: 'Show older activity' }).click(); await page.waitForTimeout(500); assert.ok(await page.locator('table.cards').nth(1).locator('tbody tr').count() > 50, 'older entries loaded');
  const lockedRow = page.locator('table.cards').nth(1).locator('tr', { hasText: 'Account locked after failed sign-ins' }).first(); assert.match(await lockedRow.locator('td[data-label="What"]').innerText(), /Account locked after failed sign-ins — lockme/); await lockedRow.locator('summary').click(); await lockedRow.getByText('From address').waitFor();
  await ac.post('/api/users', { username: 'named.target', display_name: 'N', role: 'viewer' }); await page.reload(); await page.getByText(/Created an account — named\.target/).waitFor(); await context.close();
});
