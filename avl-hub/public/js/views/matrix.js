import { h } from '../dom.js';
import { get } from '../api.js';
import { can } from '../app.js';

export async function render(root) {
  const { users, skills, scores, signoffs } = await get('/skill-matrix');
  const so = new Map(signoffs.map(s => [s.trainee_id + s.module_id, s.stale]));
  const everyone = can('progress.view_all');
  root.append(h('h1', {}, 'Skill matrix'), h('p', { class: 'hint' }, everyone
    ? 'Latest practical score per skill (0–3; 2 or more is competent). ✓ = a trainer signed the whole module off. ⚠ = signed off, but the module has changed since.'
    : 'Your own practical scores (0–3; 2 or more is competent). ✓ = signed off. ⚠ = signed off, but the module has changed since. Your role shows only your own row.'));
  if (!skills.length) return root.append(h('p', { class: 'hint' }, 'No practical skills defined yet.'));
  if (!users.length) return root.append(h('p', { class: 'hint' }, 'There is nobody to show yet.'));
  const mark = (u, s) => { const k = u.id + s.module_id; return so.has(k) ? (so.get(k) ? ' ⚠' : ' ✓') : ''; };
  const say = (u, s) => { const k = u.id + s.module_id, v = scores[u.id]?.[s.id]; return `${u.display_name}, ${s.name}: ${v == null ? 'not scored' : v}${so.has(k) ? (so.get(k) ? ', signed off but the module has changed since' : ', module signed off') : ''}`; };
  root.append(h('div', { class: 'scroll card' }, h('table', { class: 'matrix' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Person'), skills.map(s => h('th', { scope: 'col', title: s.module_title }, `L${s.level} ${s.name}`)))),
    h('tbody', {}, users.map(u => h('tr', {}, h('th', { scope: 'row' }, u.display_name), skills.map(s => { const v = scores[u.id]?.[s.id];
      return h('td', { 'aria-label': say(u, s) }, v == null ? '–' : String(v), mark(u, s)); })))))));
}
