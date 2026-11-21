import { h, clear } from './dom.js';
import { get, post, setUser, warmCache } from './api.js';
import { request } from './http.js';
import * as store from './store.js';
import * as sync from './sync.js';

export const state = { user: null, offlineStart: false };
// True if the signed-in person's role holds ANY of these permissions. This only decides what to offer; the server re-checks every action.
export const can = (...perms) => !!state.user && perms.some(p => (state.user.permissions || []).includes(p));
// Identical messages are shown once (not stacked), and any message can be dismissed with a tap.
export function toast(msg) {
  const box = document.getElementById('toasts'); for (const old of [...box.children]) if (old.textContent === msg) old.remove();
  const t = h('button', { class: 'toast', type: 'button', 'aria-label': `${msg} (tap to dismiss)`, onclick: () => t.remove() }, msg); box.append(t); setTimeout(() => t.remove(), 8000);
}
export const navigate = hash => { if (location.hash === hash) route(); else location.hash = hash; };
// A rejected form says WHICH fields to look at, not just "Invalid input."
export const errMsg = e => {
  const d = e && e.data && Array.isArray(e.data.details) ? e.data.details : [];
  if (e && e.code === 'VALIDATION' && d.length) { const names = [...new Set(d.map(x => String(x.path || '').split('.').pop().replace(/_/g, ' ')).filter(Boolean))]; if (names.length) return `Please check: ${names.join(', ')}.`; }
  return (e && e.message) || 'Something went wrong.';
};
// Shown after a queueable change: tells the person it is safe even though it hasn't reached the server yet.
// Returns true when the change was queued (so callers can skip their normal "Saved." message).
export const noteQueued = r => { if (r && r.queued) { toast('Saved on this device. It will sync when you’re back online.'); return true; } return false; };

const NAV = [['#/equipment', 'Equipment'], ['#/training', 'Training'], ['#/updates', 'Updates'], ['#/issues', 'Issues & lessons'], ['#/matrix', 'Skill matrix'], ['#/admin', 'Admin', ['users.manage', 'roles.manage', 'sources.manage', 'audit.view', 'data.manage']]];
const VIEWS = { equipment: () => import('./views/equipment.js'), wizard: () => import('./views/wizard.js'), panels: () => import('./views/panels.js'), training: () => import('./views/training.js'),
  updates: () => import('./views/updates.js'), issues: () => import('./views/issues.js'), matrix: () => import('./views/matrix.js'), admin: () => import('./views/admin.js'), sync: () => import('./views/sync.js'), account: () => import('./views/account.js') };
const root = document.getElementById('app');
let unsubStatus = null;

export async function signOut() {
  const n = sync.status().pending;
  if (n && !confirm(`${n} change${n === 1 ? ' hasn’t' : 's haven’t'} synced yet. Signing out will discard ${n === 1 ? 'it' : 'them'}. Sign out anyway?`)) return;
  let serverDone = true; try { await post('/auth/logout'); } catch { serverDone = false; }              // offline: the server session is still alive
  await store.clearUser(state.user.id); await sync.reset(); setUser(null);
  if (!serverDone) { await store.metaSet('pendingLogout', true); toast('You are offline. You are signed out on this device, and the server will be told the moment you reconnect.'); }
  navigator.serviceWorker?.controller?.postMessage('clear-private');                  // forget cached private photos too
  state.user = null; state.offlineStart = false; route();
}

function syncLine() {
  // A link keeps its own role and name; a separate hidden live region announces changes (role=status on the link itself removed its name).
  const el = h('a', { href: '#/sync', class: 'syncline' }), live = h('span', { class: 'vh', role: 'status', 'aria-live': 'polite' });
  unsubStatus?.(); unsubStatus = sync.subscribe(s => { const t = sync.statusText(s); el.textContent = t; live.textContent = t; el.className = `syncline s-${sync.statusLevel(s)}`; });
  return h('span', {}, el, live);
}
function shell() {
  const cur = location.hash.split('/')[1] || 'equipment';
  clear(root).append(
    h('header', { class: 'top' },
      h('div', { class: 'row' },
        h('span', { class: 'brand' }, 'AVL Tech Hub'),
        h('span', { class: 'row' }, syncLine(), h('a', { href: '#/account', class: 'userlink hdr-user', 'aria-label': `My account: ${state.user.display_name}, ${state.user.role_name}`, 'aria-current': location.hash.startsWith('#/account') ? 'page' : null }, `${state.user.display_name} · ${state.user.role_name}`), h('button', { class: 'hdr-user', onclick: signOut }, 'Sign out'))),
      h('nav', { class: 'main', 'aria-label': 'Main' }, NAV.filter(([, , r]) => !r || can(...r)).map(([href, label]) =>
        h('a', { href, 'aria-current': href === '#/' + cur || ((cur === 'wizard' || cur === 'panels') && href === '#/equipment') ? 'page' : null }, label)),
        h('a', { href: '#/account', class: 'account-nav', 'aria-current': cur === 'account' ? 'page' : null }, 'Account'))),
    h('main', { id: 'main', tabindex: '-1' }));
  const main = root.querySelector('main');
  const n = sync.notices().length;
  if (n) main.before(h('div', { class: 'notice', role: 'status' }, `Heads up: ${n === 1 ? 'one of your offline changes was' : `${n} of your offline changes were`} not applied because someone else changed the same thing more recently. `, h('a', { href: '#/sync' }, 'See details')));
  return main;
}

// Who is signed in? Ask the server; if we are offline, fall back to the person who was signed in on this device.
async function resolveUser() {
  // A sign-out made while offline is finished first, so a returning connection can never silently sign the person back in.
  if (await store.metaGet('pendingLogout')) {
    try { await request('POST', '/api/auth/logout'); await store.metaSet('pendingLogout', false); } catch { return; }          // still offline: stay signed out here
  }
  try {
    const r = await request('GET', '/api/me');
    if (r.ok) { state.user = r.json.user; state.offlineStart = false; await store.metaSet('user', state.user); return; }
  } catch { /* offline */
    const cached = await store.metaGet('user');
    if (cached && !cached.must_change_password) { state.user = cached; state.offlineStart = true; sync.markOffline(true); }
  }
}
async function activate() {
  setUser(state.user.id); await sync.init(state.user.id);
  if (!sync.status().offline) setTimeout(() => warmCache(state.user.permissions), 1200);
}

let seq = 0, firstRender = true;
async function route() {
  const my = ++seq;
  if (!state.user) { await resolveUser(); if (my !== seq) return; }
  if (!state.user) return (await import('./views/login.js')).renderLogin(clear(root), onAuth);
  if (state.user.must_change_password) return (await import('./views/login.js')).renderChange(clear(root), onAuth);
  if (state.user.must_enroll_mfa) { const mod = await import('./views/account.js'); if (my !== seq) return; return mod.renderForcedEnrol(root, onAuth, signOut); }
  await activate(); if (my !== seq) return;
  const [, name = 'equipment', arg] = location.hash.split('/');
  const key = name === 'equipment' && arg === 'new' ? 'wizard' : name;
  if (!VIEWS[key]) return navigate('#/equipment');
  const main = shell();
  main.append(h('p', { class: 'hint' }, 'Loading…'));
  try {
    const mod = await VIEWS[key]();
    if (my !== seq) return;
    clear(main);
    // A role that cannot add equipment is told so up front, instead of filling in four steps and failing at the end.
    if (key === 'wizard' && !can('equipment.edit')) main.append(h('h1', {}, 'Add equipment'), h('div', { class: 'notice' }, 'Your role can’t add equipment. Ask a team leader if you need that.'), h('p', {}, h('a', { href: '#/equipment' }, '← Back to the equipment library')));
    else await mod.render(main, { arg: key === 'wizard' ? null : arg, user: state.user });
    const title = main.querySelector('h1'); document.title = (title ? title.textContent + ' – ' : '') + 'AVL Tech Hub';
    if (my === seq && !firstRender) main.focus({ preventScroll: true });          // not on the very first load, so the skip link is the first Tab stop
    firstRender = false;
  } catch (e) {
    if (my !== seq) return;
    clear(main).append(h('div', { class: 'notice bad', role: 'alert' }, errMsg(e), e && e.code === 'OFFLINE' ? ' Open it once while online to save it for offline use.' : ''));
  }
}
function onAuth(user) { state.user = user; state.offlineStart = false; store.metaSet('user', user); if (!location.hash || location.hash === '#/') location.hash = '#/equipment'; route(); }

window.addEventListener('hashchange', route);
// Another tab on this browser signed in as a different person: forget who THIS tab thought it was and ask the server.
window.addEventListener('avl:session-changed', () => { state.user = null; setUser(null); sync.reset(); toast('Someone else signed in on this browser. Showing the current account.'); route(); });
window.addEventListener('avl:signed-out', () => { if (state.user) { state.user = null; route(); } });
window.addEventListener('avl:password-change', () => { if (state.user) { state.user.must_change_password = true; route(); } });
window.addEventListener('avl:mfa-enroll', () => { if (state.user && !state.user.must_enroll_mfa) { state.user.must_enroll_mfa = true; route(); } });
window.addEventListener('avl:superseded', e => toast(`Someone else changed this more recently, so their version was kept and your change to “${e.detail}” was not applied.`));
// After queued changes reach the server, refresh what is on screen — unless the person is in the middle of typing.
// If a form is open with something typed in it, never replace the page underneath the person; tell them instead.
const editing = () => [...document.querySelectorAll('main textarea, main input:not([type=search]):not([type=checkbox]):not([type=radio]):not([type=file]), main select')].some(e => e.offsetParent && (e.value || '').trim() && !e.closest('[data-keep]')) || !!document.querySelector('main form .cross, main .cross');
window.addEventListener('avl:synced', () => {
  const name = location.hash.split('/')[1];
  if (!['wizard', 'sync', undefined].includes(name) && state.user) { if (editing()) toast('Your changes were saved. Reload this page to see the latest.'); else route(); }
  warmCache(state.user?.permissions);
});
// The skip link must not change the address (the router would treat it as a page); it just moves focus.
document.querySelector('.skip')?.addEventListener('click', e => { e.preventDefault(); document.getElementById('main')?.focus(); });

// Installable + offline: register the service worker, and tell the person when a new version has arrived.
if ('serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('The app was updated. Reload to use the new version.'); });
}
route();
