import { h, clear, ROLE } from './dom.js';
import { get, post } from './api.js';

export const state = { user: null };
export const can = (...roles) => !!state.user && roles.includes(state.user.role);
export function toast(msg) {
  const t = h('div', { class: 'toast' }, msg); document.getElementById('toasts').append(t); setTimeout(() => t.remove(), 4500);
}
export const navigate = hash => { if (location.hash === hash) route(); else location.hash = hash; };
export const errMsg = e => (e && e.message) || 'Something went wrong.';

const NAV = [['#/equipment', 'Equipment'], ['#/training', 'Training'], ['#/updates', 'Updates'], ['#/issues', 'Issues & lessons'], ['#/matrix', 'Skill matrix'], ['#/admin', 'Admin', ['admin']]];
const VIEWS = { equipment: () => import('./views/equipment.js'), wizard: () => import('./views/wizard.js'), training: () => import('./views/training.js'),
  updates: () => import('./views/updates.js'), issues: () => import('./views/issues.js'), matrix: () => import('./views/matrix.js'), admin: () => import('./views/admin.js') };
const root = document.getElementById('app');

function shell() {
  const cur = location.hash.split('/')[1] || 'equipment';
  clear(root).append(
    h('header', { class: 'top' },
      h('div', { class: 'row' },
        h('span', { class: 'brand' }, 'AVL Tech Hub'),
        h('span', { class: 'row' }, h('span', {}, `${state.user.display_name} · ${ROLE[state.user.role]}`),
          h('button', { onclick: async () => { try { await post('/auth/logout'); } catch {} state.user = null; route(); } }, 'Sign out'))),
      h('nav', { class: 'main', 'aria-label': 'Main' }, NAV.filter(([, , r]) => !r || can(...r)).map(([href, label]) =>
        h('a', { href, 'aria-current': href === '#/' + cur || (cur === 'wizard' && href === '#/equipment') ? 'page' : null }, label)))),
    h('main', { id: 'main', tabindex: '-1' }));
  return root.querySelector('main');
}

let seq = 0;
async function route() {
  const my = ++seq;
  if (!state.user) {
    try { state.user = (await get('/me')).user; } catch { /* not signed in */ }
    if (my !== seq) return;                       // a newer navigation took over while we waited
  }
  if (!state.user) return (await import('./views/login.js')).renderLogin(clear(root), onAuth);
  if (state.user.must_change_password) return (await import('./views/login.js')).renderChange(clear(root), onAuth);
  const [, name = 'equipment', arg] = location.hash.split('/');
  const key = name === 'equipment' && arg === 'new' ? 'wizard' : name;
  if (!VIEWS[key]) return navigate('#/equipment');
  const main = shell();
  main.append(h('p', { class: 'hint' }, 'Loading…'));
  try {
    const mod = await VIEWS[key]();
    if (my !== seq) return;
    clear(main);
    await mod.render(main, { arg: key === 'wizard' ? null : arg, user: state.user });
    document.title = 'AVL Tech Hub';
    if (my === seq) main.focus({ preventScroll: true });
  } catch (e) {
    if (my !== seq) return;
    clear(main).append(h('div', { class: 'notice bad', role: 'alert' }, errMsg(e)));
  }
}
function onAuth(user) { state.user = user; if (!location.hash || location.hash === '#/') location.hash = '#/equipment'; route(); }

window.addEventListener('hashchange', route);
window.addEventListener('avl:signed-out', () => { if (state.user) { state.user = null; route(); } });
window.addEventListener('avl:password-change', () => { if (state.user) { state.user.must_change_password = true; route(); } });
route();
