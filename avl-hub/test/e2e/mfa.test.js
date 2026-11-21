'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { harness, PW } = require('../helpers');
const T = require('../../server/lib/totp');

const KEY = 'ab12'.repeat(16); let t = Date.UTC(2026, 10, 20, 12, 0, 0); const clock = () => t, adv = s => { t += s * 1000; };
const code = secret => T.hotp(T.base32Decode(secret.replace(/\s/g, '')), T.stepOf(t));
let h, browser;
before(async () => { h = await harness({ mfaEncryptionKey: KEY, clock }); browser = await chromium.launch(); await h.makeUser('admin', 'boss'); });
after(async () => { await browser?.close(); await h.close(); });

async function signIn(username, { password = PW, viewport = { width: 1000, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport }); const page = await context.newPage();
  await page.goto(h.base + '/'); await page.getByLabel('Username').fill(username); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in' }).click();
  return { page, context };
}
const ready = p => p.getByRole('heading', { name: 'Equipment library' }).waitFor();

test('a person turns on two-step sign-in themselves, then signs in with a code; recovery codes work once; wrong codes are refused', async () => {
  await h.makeUser('technician', 'tina');
  const { page, context } = await signIn('tina'); await ready(page);
  await page.getByRole('link', { name: /My account: Sample tina/ }).click(); await page.getByRole('heading', { name: 'My account' }).waitFor();
  await page.getByText('Off', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await page.getByLabel('Your password').fill('wrong-password-123'); await page.getByRole('button', { name: 'Continue' }).click(); await page.getByText('That password is not correct.').waitFor();
  await page.getByLabel('Your password').fill(PW); await page.getByRole('button', { name: 'Continue' }).click();
  const qr = page.getByRole('img', { name: /QR code to scan/ }); await qr.waitFor();
  assert.ok(await qr.evaluate(i => i.naturalWidth > 100), 'the QR image really rendered (CSP allows data: images)');
  assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/);
  await page.getByText('Can’t scan? Type the key instead').click(); const secret = (await page.locator('code.key').textContent()).trim(); assert.match(secret, /^([A-Z2-7]{4} ?)+$/);
  await page.getByLabel(/type the 6-digit code/).fill('000000'); await page.getByRole('button', { name: 'Turn on', exact: true }).click(); await page.getByText(/code was not accepted/).waitFor();
  adv(30); await page.getByLabel(/type the 6-digit code/).fill(code(secret)); await page.getByRole('button', { name: 'Turn on', exact: true }).click();
  await page.getByRole('heading', { name: 'Two-step sign-in is on' }).waitFor();
  const codes = await page.locator('.codes code').allTextContents(); assert.equal(codes.length, 8);
  assert.equal(await page.getByRole('button', { name: 'Done' }).isDisabled(), true, '“Done” waits until they confirm they saved the codes');
  await page.getByLabel('I have saved these codes').check(); await page.getByRole('button', { name: 'Done' }).click();
  await page.getByText('On', { exact: true }).waitFor(); await page.getByText('Recovery codes left: 8.').waitFor();
  await page.locator('header.top').getByRole('button', { name: 'Sign out' }).click(); await page.getByLabel('Username').waitFor(); await context.close();

  // signing in now needs the second step
  const s = await signIn('tina'); await s.page.getByRole('heading', { name: 'Two-step sign-in' }).waitFor();
  assert.equal(await s.page.getByRole('heading', { name: 'Equipment library' }).count(), 0, 'password alone does not get in');
  const input = s.page.getByLabel('Authentication code'); assert.equal(await input.getAttribute('autocomplete'), 'one-time-code'); assert.equal(await input.getAttribute('inputmode'), 'numeric');
  await input.fill('123456'); await s.page.getByRole('button', { name: 'Sign in' }).click(); await s.page.getByText('That code was not accepted.').waitFor();
  adv(30); await input.fill(code(secret)); await s.page.getByRole('button', { name: 'Sign in' }).click(); await ready(s.page);
  await s.page.locator('header.top').getByRole('button', { name: 'Sign out' }).click(); await s.page.getByLabel('Username').fill('tina'); await s.page.getByLabel('Password').fill(PW); await s.page.getByRole('button', { name: 'Sign in' }).click();
  await s.page.getByRole('button', { name: 'Use a recovery code instead' }).click(); await s.page.getByLabel('Recovery code').fill(codes[0].toUpperCase()); await s.page.getByRole('button', { name: 'Sign in' }).click(); await ready(s.page);
  await s.page.getByRole('link', { name: /My account/ }).click(); await s.page.getByText('Recovery codes left: 7.').waitFor();
  await s.page.locator('header.top').getByRole('button', { name: 'Sign out' }).click(); await s.page.getByLabel('Username').fill('tina'); await s.page.getByLabel('Password').fill(PW); await s.page.getByRole('button', { name: 'Sign in' }).click();
  await s.page.getByRole('button', { name: 'Use a recovery code instead' }).click(); await s.page.getByLabel('Recovery code').fill(codes[0]); await s.page.getByRole('button', { name: 'Sign in' }).click(); await s.page.getByText('That code was not accepted.').waitFor();
  await s.context.close();
});

test('a role can require it: the person sees only the setup screen until done; the admin sets the requirement from the Roles screen', async () => {
  const adm = await signIn('boss'); await ready(adm.page); await adm.page.getByRole('link', { name: 'Admin', exact: true }).click();
  await adm.page.getByRole('heading', { name: 'Roles and permissions' }).waitFor();
  const card = adm.page.locator('.card', { has: adm.page.locator('strong', { hasText: 'Technician' }) }).first(); await card.getByRole('button', { name: 'Edit' }).click();
  const box = adm.page.getByLabel('Require two-step sign-in for people in this role'); assert.equal(await box.isDisabled(), false, 'available because the server has a key'); await box.check();
  await adm.page.getByRole('button', { name: 'Save role' }).click(); await adm.page.getByText('Saved.').waitFor(); await adm.page.getByText('Requires two-step').waitFor();
  await h.makeUser('technician', 'forced');
  const u = await signIn('forced'); await u.page.getByRole('heading', { name: 'Set up two-step sign-in' }).waitFor(); await u.page.getByText('Your role requires two-step sign-in.').waitFor();
  assert.equal(await u.page.getByRole('link', { name: 'Equipment' }).count(), 0, 'no app navigation until set up');
  await u.page.getByRole('button', { name: 'Turn on two-step sign-in' }).click(); await u.page.getByLabel('Your password').fill(PW); await u.page.getByRole('button', { name: 'Continue' }).click();
  await u.page.getByRole('img', { name: /QR code/ }).waitFor(); await u.page.getByText('Can’t scan? Type the key instead').click(); const secret = (await u.page.locator('code.key').textContent()).trim();
  adv(30); await u.page.getByLabel(/type the 6-digit code/).fill(code(secret)); await u.page.getByRole('button', { name: 'Turn on', exact: true }).click();
  await u.page.getByRole('heading', { name: 'Two-step sign-in is on' }).waitFor(); await u.page.getByLabel('I have saved these codes').check(); await u.page.getByRole('button', { name: 'Done' }).click();
  await ready(u.page);                                                                             // through to the app
  await u.page.getByRole('link', { name: /My account/ }).click(); await u.page.getByText('Your role requires two-step sign-in, so it cannot be turned off.').waitFor();
  assert.equal(await u.page.getByRole('button', { name: 'Turn off' }).count(), 0);
  // lost phone: the admin resets it from the People table
  await adm.page.reload(); await adm.page.getByRole('heading', { name: 'Roles and permissions' }).waitFor();
  const row = adm.page.locator('tr', { hasText: 'forced' }); await row.getByText(/two-step on/).waitFor();
  adm.page.once('dialog', d => d.accept()); await row.getByRole('button', { name: 'Reset two-step sign-in for forced' }).click(); await adm.page.getByText('Two-step sign-in reset.').waitFor(); await adm.page.locator('tr', { hasText: 'forced' }).getByText(/two-step on/).waitFor({ state: 'detached' });
  await adm.context.close(); await u.context.close();
});

test('on a server without a key the option says so, and the role form cannot require it', async () => {
  const H = await harness(); const B = await chromium.launch();                                    // no mfaEncryptionKey
  try {
    await H.makeUser('admin', 'noadmin'); const ctx = await B.newContext(); const p = await ctx.newPage(); await p.goto(H.base + '/'); await p.getByLabel('Username').fill('noadmin'); await p.getByLabel('Password').fill(PW); await p.getByRole('button', { name: 'Sign in' }).click();
    await p.getByRole('heading', { name: 'Equipment library' }).waitFor(); await p.getByRole('link', { name: /My account/ }).click(); await p.getByText('Two-step sign-in is not available on this server.').waitFor();
    await p.getByRole('link', { name: 'Admin', exact: true }).click(); await p.getByRole('heading', { name: 'Roles and permissions' }).waitFor(); await p.getByRole('button', { name: 'New role' }).click();
    assert.equal(await p.getByLabel('Require two-step sign-in for people in this role').isDisabled(), true); await p.getByText(/not set up on this server/).waitFor();
  } finally { await B.close(); await H.close(); }
});

test('the account and code screens on a phone: labelled, 44px, no sideways scroll', async () => {
  // a role that does not require two-step (an earlier test made Technician require it)
  await h.makeUser('viewer', 'mobile.user'); const { page, context } = await signIn('mobile.user', { viewport: { width: 390, height: 844 } }); await ready(page);
  await page.getByRole('link', { name: 'Account', exact: true }).click(); await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click(); await page.getByLabel('Your password').fill(PW); await page.getByRole('button', { name: 'Continue' }).click(); await page.getByRole('img', { name: /QR code/ }).waitFor();
  const audit = () => page.evaluate(() => ({
    small: [...document.querySelectorAll('button,a.btn,nav a,.userlink,select,summary,input:not([type=checkbox])')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 43.5).map(e => (e.getAttribute('aria-label') || e.textContent).slice(0, 30)),
    unlabeled: [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(e => e.offsetParent && !e.labels?.length && !e.getAttribute('aria-label')).length, overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    qr: document.querySelector('img.qr').getBoundingClientRect().width }));
  const a = await audit(); assert.deepEqual(a.small, []); assert.equal(a.unlabeled, 0); assert.equal(a.overflow, false); assert.ok(a.qr >= 200, 'QR code is big enough to scan');
  await context.close();
});
