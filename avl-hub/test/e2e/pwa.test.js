'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { harness, PW } = require('../helpers');

let h, browser, boss, equip;
before(async () => {
  h = await harness({ maxVideoMb: 5 });
  browser = await chromium.launch();
  boss = await h.makeUser('admin', 'boss');
  const ac = await h.as(boss);
  equip = (await ac.post('/api/equipment', { name: 'SAMPLE Stage Box', manufacturer: 'SAMPLE Co', fields: [{ key: 'rack', provenance: 'team', value: 'SAMPLE 2U' }] })).body.equipment;
  await ac.put(`/api/equipment/${equip.id}/install-steps`, { steps: [{ text: 'SAMPLE step one', provenance: 'team' }] });
});
after(async () => { await browser?.close(); await h.close(); });

async function open(username, { viewport = { width: 1000, height: 800 }, ctx } = {}) {
  const context = ctx || await browser.newContext({ viewport }); const page = await context.newPage();
  await page.goto(h.base + '/'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(PW); await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Equipment library' }).waitFor(); return { page, context };
}
const idbKeys = page => page.evaluate(() => new Promise(res => { const r = indexedDB.open('avl-hub'); r.onerror = () => res([]); r.onsuccess = () => { const q = r.result.transaction('cache').objectStore('cache').getAllKeys(); q.onsuccess = () => res(q.result); }; }));
const waitCached = async (page, ...needles) => { for (let i = 0; i < 120; i++) { const k = await idbKeys(page); if (needles.every(n => k.some(x => x.endsWith(n)))) return; await page.waitForTimeout(250); } throw new Error('cache not warmed: ' + needles); };
const sync = page => page.locator('.syncline');
const online = async (ctx, page) => { await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); };
const dbName = id => h.db.prepare('SELECT name FROM equipment WHERE id=?').get(id).name;

test('PWA basics: valid manifest, real icons, install meta tags, service worker serves a fresh precache list', async () => {
  const m = await (await fetch(h.base + '/manifest.webmanifest')).json();
  assert.equal(m.display, 'standalone'); assert.equal(m.start_url, '/'); assert.equal(m.scope, '/'); assert.ok(m.name && m.short_name); assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  const sizes = new Set();
  for (const i of m.icons) {
    const buf = Buffer.from(await (await fetch(h.base + i.src)).arrayBuffer());
    assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), i.src + ' is a PNG');
    assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, i.sizes, i.src + ' size matches the manifest'); sizes.add(i.sizes + i.purpose);
  }
  assert.ok(sizes.has('192x192any') && sizes.has('512x512any') && sizes.has('512x512maskable'));
  const html = await (await fetch(h.base + '/')).text();
  for (const needle of ['rel="manifest"', 'rel="apple-touch-icon"', 'name="apple-mobile-web-app-capable"', 'name="theme-color"', 'viewport-fit=cover']) assert.ok(html.includes(needle), needle);
  const apple = Buffer.from(await (await fetch(h.base + '/icons/apple-touch-icon.png')).arrayBuffer()); assert.equal(apple.readUInt32BE(16), 180);
  const swRes = await fetch(h.base + '/sw.js'); assert.match(swRes.headers.get('cache-control'), /no-cache/); assert.match(swRes.headers.get('content-type'), /javascript/);
  const pre = await (await fetch(h.base + '/precache.json')).json();
  for (const must of ['/index.html', '/js/app.js', '/css/app.css', '/js/sync.js', '/js/store.js', '/manifest.webmanifest', '/icons/icon-192.png']) assert.ok(pre.assets.includes(must), must + ' is precached');
  assert.ok(!pre.assets.some(a => a.startsWith('/vendor/') || a.startsWith('/api/')), 'big optional assets and API data are not precached');
  const swText = await swRes.text(); assert.ok(swText.includes(`const VERSION = '${pre.version}'`), 'the cache name carries the build version'); assert.ok(!swText.includes('__VERSION__') && !swText.includes('__ASSETS__'), 'template fully filled in');
});

test('the service worker takes control, precaches the whole shell, and never caches API data', async () => {
  const { page, context } = await open('boss');
  await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'page is controlled by the service worker');
  const pre = await (await fetch(h.base + '/precache.json')).json();
  const info = await page.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname); return out; });
  const shell = Object.entries(info).find(([k]) => k.startsWith('avl-shell-')); assert.ok(shell, 'a versioned shell cache exists'); assert.ok(shell[0].endsWith(pre.version));
  for (const a of pre.assets) assert.ok(shell[1].includes(a), a + ' cached');
  assert.ok(!Object.values(info).flat().some(p => p.startsWith('/api/') && !p.startsWith('/api/files/')), 'no API data in service-worker caches');
  await context.close();
});

test('the installed app OPENS OFFLINE after the first load, and shows saved data with a clear status', async () => {
  const { page, context } = await open('boss');
  assert.match(await sync(page).textContent(), /All changes saved/);
  await page.evaluate(() => navigator.serviceWorker.ready); await page.reload();
  await waitCached(page, `/equipment/${equip.id}`, `/equipment/${equip.id}/install-steps`, '/modules', '/issues');
  await context.setOffline(true);
  await page.reload();                                                                    // a full page load with no network at all
  await page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  await page.getByText('SAMPLE Stage Box').waitFor();
  await sync(page).filter({ hasText: 'Offline — showing saved data' }).waitFor();
  await page.getByRole('link', { name: /SAMPLE Stage Box/ }).click();                      // and cached detail pages work too
  await page.getByRole('heading', { name: 'SAMPLE Stage Box' }).waitFor(); await page.getByText('SAMPLE step one').waitFor();
  for (const [link, heading] of [['Training', 'Training'], ['Issues & lessons', 'Issues & lessons learned'], ['Updates', 'Update management']]) { await page.getByRole('link', { name: link, exact: true }).click(); await page.getByRole('heading', { name: heading, exact: true }).waitFor(); }
  // things that truly need a connection say so plainly instead of failing mysteriously
  await page.getByRole('link', { name: 'Admin', exact: true }).click(); await page.getByRole('heading', { name: 'Admin', exact: true }).waitFor();
  await page.getByText('Create an account').click(); await page.getByLabel('Username').fill('someone'); await page.getByLabel('Display name').fill('Some One');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByText(/needs a connection/).waitFor();
  await online(context, page); await sync(page).filter({ hasText: 'All changes saved' }).waitFor();
  await context.close();
});

test('edits made offline are queued, visible immediately, survive a reload, and sync (attributed, with the real edit time recorded) when back online', async () => {
  await h.makeUser('technician', 'phone');
  const { page, context } = await open('phone');
  await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await waitCached(page, `/equipment/${equip.id}`, `/equipment/${equip.id}/install-steps`);
  await page.evaluate(id => { location.hash = '#/equipment/' + id; }, equip.id); await page.getByRole('heading', { name: 'SAMPLE Stage Box' }).waitFor();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('SAMPLE Stage Box (edited offline)'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText(/Saved on this device/).waitFor();
  await page.getByRole('heading', { name: 'SAMPLE Stage Box (edited offline)' }).waitFor();
  await sync(page).filter({ hasText: 'Offline — 1 change waiting to sync' }).waitFor();
  assert.equal(dbName(equip.id), 'SAMPLE Stage Box', 'the server has not seen it yet');
  await page.reload(); await page.getByRole('heading', { name: 'SAMPLE Stage Box (edited offline)' }).waitFor();         // survives a reload
  await sync(page).filter({ hasText: '1 change waiting to sync' }).waitFor();
  // a checklist tick is queued too
  await page.getByLabel(/1\. SAMPLE step one/).check(); await sync(page).filter({ hasText: '2 changes waiting to sync' }).waitFor();
  await online(context, page);
  await sync(page).filter({ hasText: 'All changes saved' }).waitFor({ timeout: 20000 });
  assert.equal(dbName(equip.id), 'SAMPLE Stage Box (edited offline)', 'the change reached the server');
  const phone = h.db.prepare("SELECT id FROM users WHERE username='phone'").get().id;
  const entry = h.db.prepare("SELECT * FROM audit_log WHERE action='equipment.update' AND entity_id=? ORDER BY id DESC").get(equip.id);
  assert.equal(entry.actor_id, phone, 'attributed to the signed-in user'); assert.ok(JSON.parse(entry.detail).occurred_at, 'real edit time kept');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM install_progress WHERE user_id=?').get(phone).n, 1);
  await context.close();
});

test('TWO CLIENTS, ONE RECORD: the later edit wins whichever device syncs last, and the loser is told', async () => {
  await h.makeUser('technician', 'laptop');
  const ac = await h.as(boss);
  for (const scenario of ['phone-first', 'laptop-first']) {
    const e = (await ac.post('/api/equipment', { name: `SAMPLE ${scenario} original`, fields: [] })).body.equipment;
    const A = await open('phone'), B = await open('laptop');                              // A = phone (goes offline), B = laptop (stays online)
    for (const x of [A, B]) { await x.page.evaluate(() => navigator.serviceWorker.ready); await waitCached(x.page, `/equipment/${e.id}`); await x.page.evaluate(id => { location.hash = '#/equipment/' + id; }, e.id); await x.page.getByRole('heading', { name: `SAMPLE ${scenario} original` }).waitFor(); }
    await A.context.setOffline(true);
    const rename = async (x, name) => { await x.page.getByRole('button', { name: 'Edit', exact: true }).click(); await x.page.getByLabel('Name', { exact: true }).fill(name); await x.page.getByRole('button', { name: 'Save', exact: true }).click(); };
    const phoneName = `SAMPLE ${scenario} by phone`, laptopName = `SAMPLE ${scenario} by laptop`;
    if (scenario === 'phone-first') {
      await rename(A, phoneName); await A.page.getByText(/Saved on this device/).waitFor();      // phone edits first (offline)…
      await B.page.waitForTimeout(1100); await rename(B, laptopName); await B.page.getByText('Saved.').waitFor();   // …laptop edits LATER, online
      await online(A.context, A.page); await sync(A.page).filter({ hasText: 'All changes saved' }).waitFor({ timeout: 20000 });
      assert.equal(dbName(e.id), laptopName, 'the later (laptop) edit wins even though the phone synced last');
      await A.page.getByText(/were not applied|was not applied/).first().waitFor();                // the phone user is told, persistently (not only a toast)
      assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='sync.superseded' AND entity_id=?").get(e.id), 'recorded in the audit log');
    } else {
      await rename(B, laptopName); await B.page.getByText('Saved.').waitFor();                 // laptop edits first (online)…
      await A.page.waitForTimeout(1100); await rename(A, phoneName); await A.page.getByText(/Saved on this device/).waitFor();   // …phone edits LATER, offline
      await online(A.context, A.page); await sync(A.page).filter({ hasText: 'All changes saved' }).waitFor({ timeout: 20000 });
      assert.equal(dbName(e.id), phoneName, 'the later (phone) edit wins when it finally syncs');
    }
    await A.context.close(); await B.context.close();
  }
});

test('equipment added offline through the wizard syncs once, with its own id, and appears for everyone', async () => {
  await h.makeUser('technician', 'newbie');
  const { page, context } = await open('newbie');
  await page.evaluate(() => navigator.serviceWorker.ready); await waitCached(page, '/equipment', '/updates', '/issues');
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Add equipment' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Equipment name / model').fill('SAMPLE Offline Camera'); await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Search official sources' }).click(); await page.getByText(/needs a connection|offline/i).first().waitFor();   // research is honest about needing a connection
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Save and submit for review' }).click();
  await page.getByText(/Saved on this device/).waitFor();
  await page.getByRole('heading', { name: 'SAMPLE Offline Camera' }).waitFor();             // detail page works for a record that only exists locally
  await page.getByText('Needs Review').first().waitFor(); await sync(page).filter({ hasText: /Offline — 2 changes waiting to sync/ }).waitFor();
  await online(context, page); await sync(page).filter({ hasText: 'All changes saved' }).waitFor({ timeout: 20000 });
  const rows = h.db.prepare("SELECT status FROM equipment WHERE name='SAMPLE Offline Camera'").all();
  assert.equal(rows.length, 1, 'created exactly once'); assert.equal(rows[0].status, 'needs_review');
  await context.close();
});

test('sign-offs queued offline are append-only events: valid ones are recorded under the trainer, invalid ones are refused visibly and never silently dropped', async () => {
  const tcUser = await h.makeUser('trainer', 'coach'); const tc = await h.as(tcUser);
  const good = await h.makeUser('technician', 'goodtrainee'), bad = await h.makeUser('technician', 'badtrainee');
  const m = (await tc.post('/api/modules', { title: 'SAMPLE offline signoff', level: 1 })).body.module;
  const q = (await tc.post(`/api/modules/${m.id}/questions`, { prompt: 'SAMPLE q', options: ['a', 'b'], correct_index: 1 })).body.id;
  const sk = (await tc.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE skill' })).body.id;
  await (await h.as(boss)).post(`/api/modules/${m.id}/approve`);
  const gc = await h.as(good); await gc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: { [q]: 1 } }); await tc.post('/api/practical-scores', { trainee_id: good.id, skill_id: sk, score: 3 });
  const { page, context } = await open('coach');
  await page.evaluate(() => navigator.serviceWorker.ready); await waitCached(page, `/modules/${m.id}`, `/progress/${good.id}`, `/progress/${bad.id}`);
  await page.getByRole('link', { name: 'Training' }).click(); await page.getByRole('link', { name: /SAMPLE offline signoff/ }).click(); await page.getByRole('heading', { name: 'Trainer: score and sign off' }).waitFor();
  await context.setOffline(true);
  for (const who of ['Sample goodtrainee', 'Sample badtrainee']) {
    await page.getByLabel('Trainee').selectOption({ label: who }); await page.getByRole('button', { name: 'Sign off this trainee' }).click(); await page.getByText(/Saved on this device/).waitFor();
    await page.getByLabel('Trainee').selectOption({ label: '' }).catch(() => {});
  }
  await sync(page).filter({ hasText: /Offline — 2 changes waiting to sync/ }).waitFor();
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM signoffs').get().n, 0);
  await online(context, page);
  await sync(page).filter({ hasText: '1 change needs attention' }).waitFor({ timeout: 20000 });
  const so = h.db.prepare('SELECT * FROM signoffs').all();
  assert.equal(so.length, 1); assert.equal(so[0].trainee_id, good.id); assert.equal(so[0].signed_by, tcUser.id, 'recorded under the signed-in trainer');
  await sync(page).click(); await page.getByRole('heading', { name: 'Sync' }).waitFor();
  await page.getByText(/Sign-off requirements are not met/).waitFor(); await page.getByText(/Written: best quiz score is none/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Try again' }).count(), 1);
  await page.getByRole('button', { name: 'Discard' }).click().catch(() => {}); // confirm dialog auto-dismissed by default; discard stays
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Discard' }).click();
  await sync(page).filter({ hasText: 'All changes saved' }).waitFor();
  await context.close();
});

test('signing out with unsynced changes warns first, and clears everything saved on the device', async () => {
  await h.makeUser('technician', 'leaver');
  const { page, context } = await open('leaver');
  await page.evaluate(() => navigator.serviceWorker.ready); await waitCached(page, `/equipment/${equip.id}`);
  await page.evaluate(id => { location.hash = '#/equipment/' + id; }, equip.id); await page.getByRole('heading', { level: 1 }).first().waitFor();
  await context.setOffline(true);
  await page.getByLabel(/1\. SAMPLE step one/).check(); await sync(page).filter({ hasText: '1 change waiting to sync' }).waitFor();
  let msg = ''; page.once('dialog', d => { msg = d.message(); d.dismiss(); });
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.waitForTimeout(300);
  assert.match(msg, /hasn’t synced yet/); await sync(page).filter({ hasText: '1 change waiting to sync' }).waitFor();          // cancelled: still here
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'AVL Tech Hub' }).waitFor();
  assert.deepEqual(await idbKeys(page), [], 'cached data wiped');
  const left = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('avl-hub'); r.onsuccess = () => { const q = r.result.transaction('outbox').objectStore('outbox').count(); q.onsuccess = () => res(q.result); }; }));
  assert.equal(left, 0, 'queued changes discarded with the sign-out the person confirmed');
  await page.reload(); await page.getByLabel('Username').waitFor();                         // offline reload does not resurrect the session
  await context.close();
});
