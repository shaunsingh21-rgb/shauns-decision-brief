import { h } from '../dom.js';
import { get } from '../api.js';

export async function render(root) {
  const { users, skills, scores, signoffs } = await get('/skill-matrix');
  const so = new Set(signoffs.map(s => s.trainee_id + s.module_id));
  root.append(h('h1', {}, 'Skill matrix'), h('p', { class: 'hint' }, 'Latest practical score per skill (0–3; 2 or more is competent). ✓ = trainer signed off the whole module.'));
  if (!skills.length) return root.append(h('p', { class: 'hint' }, 'No practical skills defined yet.'));
  root.append(h('div', { class: 'scroll card' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Person'), skills.map(s => h('th', { scope: 'col', title: s.module_title }, `L${s.level} ${s.name}`)))),
    h('tbody', {}, users.map(u => h('tr', {}, h('th', { scope: 'row' }, u.display_name), skills.map(s => { const v = scores[u.id]?.[s.id];
      return h('td', { 'aria-label': `${u.display_name}, ${s.name}: ${v == null ? 'not scored' : v}` }, v == null ? '–' : String(v), so.has(u.id + s.module_id) ? ' ✓' : ''); })))))));
}
