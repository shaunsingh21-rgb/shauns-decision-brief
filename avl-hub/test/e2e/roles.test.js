'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const { harness, PW } = require('../helpers');

let h, browser, dir;
before(async () => { h = await harness(); browser = await chromium.launch(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-e2e-roles-')); await h.makeUser('admin', 'boss'); });
after(async () => { await browser?.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function open(username, password = PW, viewport = { width: 1000, height: 900 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true }); const page = await context.newPage();
  await page.goto(h.base + '/'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in' }).click();
  return { page, context };
}
const adminPage = async (vp) => { const x = await open('boss', PW, vp); await x.page.getByRole('heading', { name: 'Equipment library' }).waitFor(); await x.page.getByRole('link', { name: 'Admin', exact: true }).click(); await x.page.getByRole('heading', { name: 'Admin', exact: true }).waitFor(); return x; };

test('an admin creates a role from the screen, gives it to a new person, and that person gets exactly those powers', async () => {
  const { page, context } = await adminPage();
  await page.getByRole('heading', { name: 'Roles and permissions' }).waitFor();
  assert.ok(await page.getByText('Built-in · locked').isVisible(), 'Leader/Admin is shown as locked');
  await page.getByRole('button', { name: 'New role' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Camera Operator');
  await page.getByLabel('What is this role for? (optional)').fill('SAMPLE role for the camera crew');
  await page.getByLabel('Add and edit equipment').check(); await page.getByLabel('Take training').check();
  assert.ok(await page.getByText('Everyone signed in can read equipment, training and issues').isVisible());
  await page.getByRole('button', { name: 'Save role' }).click(); await page.getByText('Saved.').waitFor();
  await page.locator('.card strong', { hasText: 'Camera Operator' }).waitFor();
  // create a person in that role
  await page.getByText('Create an account').click();
  await page.getByLabel('Username').fill('cam.op'); await page.getByLabel('Display name').fill('Cam Op');
  await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Camera Operator' });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const temp = (await page.locator('code').textContent()).trim(); assert.ok(temp.length >= 12);
  await context.close();

  const u = await open('cam.op', temp);
  await u.page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
  await u.page.getByLabel('Current (temporary) password').fill(temp); await u.page.getByLabel('New password', { exact: true }).fill('A-fresh-passphrase-42'); await u.page.getByLabel('Repeat new password').fill('A-fresh-passphrase-42');
  await u.page.getByRole('button', { name: 'Save password' }).click(); await u.page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  assert.match(await u.page.locator('header.top').innerText(), /Cam Op · Camera Operator/);
  assert.equal(await u.page.getByRole('link', { name: 'Add equipment' }).count(), 1, 'can add equipment');
  assert.equal(await u.page.getByRole('link', { name: 'Admin', exact: true }).count(), 0, 'no Admin menu');
  await u.page.getByRole('link', { name: 'Add equipment' }).click(); await u.page.getByRole('heading', { name: 'Add equipment' }).waitFor();
  await u.page.getByRole('link', { name: 'Training' }).click(); await u.page.getByRole('heading', { name: 'Training', exact: true }).waitFor();
  assert.equal(await u.page.getByRole('button', { name: 'New module' }).count(), 0, 'cannot write training material');
  await u.page.getByRole('link', { name: 'Issues & lessons' }).click(); await u.page.getByRole('heading', { name: /Issues/ }).waitFor();
  assert.equal(await u.page.getByText('Log something').count(), 0, 'cannot log issues (no issues.write)');
  // the server, not just the screen, enforces it
  const denied = await u.page.evaluate(async () => (await fetch('/api/issues', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-by': 'avl-hub' }, body: JSON.stringify({ kind: 'issue', title: 'sneaky' }) })).status);
  assert.equal(denied, 403);
  await u.context.close();
});

test('a person who manages roles but is not an admin sees which powers they cannot give, and cannot touch more powerful roles', async () => {
  const rm = h.makeRole(['roles.manage', 'users.manage', 'equipment.edit'], 'Role Steward'); await h.makeUser(rm, 'steward');
  const { page, context } = await open('steward'); await page.getByRole('heading', { name: 'Equipment library' }).waitFor();
  await page.getByRole('link', { name: 'Admin', exact: true }).click(); await page.getByRole('heading', { name: 'Roles and permissions' }).waitFor();
  // Trainer has more power than this steward, so it cannot be edited; Leader/Admin is locked
  const trainerCard = page.locator('.card', { has: page.getByText('Runs training', { exact: false }) });
  await trainerCard.getByText(/more power than yours/).waitFor(); assert.equal(await trainerCard.getByRole('button', { name: 'Edit' }).count(), 0);
  await page.getByRole('button', { name: 'New role' }).click();
  const cannot = page.getByLabel('Approve equipment and photo panels'); assert.equal(await cannot.isDisabled(), true, 'a power the steward lacks is greyed out');
  await page.getByText('You don’t have this permission yourself, so you can’t give it.').first().waitFor();
  assert.equal(await page.getByLabel('Add and edit equipment').isDisabled(), false, 'a power the steward has can be given');
  await page.getByLabel('Name', { exact: true }).fill('Helper'); await page.getByLabel('Add and edit equipment').check(); await page.getByRole('button', { name: 'Save role' }).click(); await page.getByText('Saved.').waitFor();
  // in People: cannot manage the administrator; role pickers only offer roles up to the steward's own power
  const adminRow = page.locator('tr', { hasText: 'boss' }); await adminRow.getByText('Their role has more power than yours').waitFor();
  assert.equal(await adminRow.getByRole('button', { name: 'Reset password' }).count(), 0);
  const options = await page.locator('select[aria-label^="Role for steward"] option').allTextContents(); assert.ok(!options.includes('Leader/Admin') && !options.includes('Trainer'), `offered: ${options}`);
  await context.close();
});

test('export downloads a content file; importing it checks first, then adds nothing twice; a tampered file is refused with reasons', async () => {
  const ac = await h.as(await h.makeUser('admin', 'dataadmin')); await ac.post('/api/equipment', { name: 'SAMPLE exportable', fields: [{ key: 'note', provenance: 'team', value: 'SAMPLE' }] });
  const { page, context } = await open('dataadmin'); await page.getByRole('heading', { name: 'Equipment library' }).waitFor(); await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await page.getByRole('heading', { name: 'Export and import content' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download export' }).click()]);
  const file = path.join(dir, 'export.json'); await dl.saveAs(file); const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.format, 'avl-hub-content'); assert.ok(data.equipment.some(e => e.name === 'SAMPLE exportable')); assert.ok(!/password|argon2/i.test(JSON.stringify({ ...data, note: '' })));
  await page.getByLabel('Choose an export file').setInputFiles(file); await page.getByRole('button', { name: 'Check the file' }).click();
  await page.getByText('Check only — nothing has been changed.').waitFor(); await page.getByText(/Already present \(skipped\):.*equipment/).waitFor();
  await page.getByRole('button', { name: 'Import now' }).click(); await page.getByText('Imported.').waitFor();
  const bad = JSON.parse(JSON.stringify(data)); bad.equipment[0].fields[0].provenance = 'guess'; const badFile = path.join(dir, 'tampered.json'); fs.writeFileSync(badFile, JSON.stringify(bad));
  await page.getByLabel('Choose an export file').setInputFiles(badFile); await page.getByRole('button', { name: 'Check the file' }).click();
  await page.getByText(/not a valid AVL Hub export/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Import now' }).count(), 0);
  const notJson = path.join(dir, 'x.json'); fs.writeFileSync(notJson, 'not json'); await page.getByLabel('Choose an export file').setInputFiles(notJson); await page.getByRole('button', { name: 'Check the file' }).click(); await page.getByText('That file is not valid JSON.').waitFor();
  await context.close();
});

test('the roles screen on a phone: labelled checkboxes, 44px targets, no sideways scrolling', async () => {
  const { page, context } = await adminPage({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'New role' }).click(); await page.getByLabel('Name', { exact: true }).waitFor(); await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    small: [...document.querySelectorAll('button,a.btn,nav a,select,summary,input:not([type=file]):not([type=checkbox]):not([type=radio])')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 43.5).map(e => (e.getAttribute('aria-label') || e.textContent).slice(0, 30)),
    smallBoxes: [...document.querySelectorAll('input[type=checkbox]')].filter(e => e.offsetParent && e.closest('label').getBoundingClientRect().height < 43.5).length,
    unlabeled: [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(e => e.offsetParent && !e.labels?.length && !e.getAttribute('aria-label')).length,
    checkboxes: document.querySelectorAll('input[type=checkbox]').length, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
  assert.deepEqual(r.small, []); assert.equal(r.smallBoxes, 0, 'every checkbox row is at least 44px tall'); assert.equal(r.unlabeled, 0); assert.ok(r.checkboxes >= 19); assert.equal(r.overflow, false);
  await context.close();
});
