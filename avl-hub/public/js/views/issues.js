import { h, clear, field, select, fmtDate } from '../dom.js';
import { get, mutate } from '../api.js';
import { can, toast, errMsg, noteQueued } from '../app.js';

export async function render(root) {
  const [{ issues }, { equipment }, { people }] = await Promise.all([get('/issues'), get('/equipment'), get('/people')]);
  const eqName = Object.fromEntries(equipment.map(e => [e.id, e.name])), who = Object.fromEntries(people.map(p => [p.id, p.display_name]));
  let kind = 'all';
  const list = h('div');
  const draw = () => clear(list).append(...issues.filter(i => kind === 'all' || i.kind === kind).map(i => h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'badge b-draft' }, i.kind === 'lesson' ? 'Lesson learned' : 'Issue'), h('span', { class: `badge ${i.status === 'resolved' ? 'b-approved' : 'b-needs_review'}` }, i.status === 'resolved' ? 'Resolved' : 'Open')),
    h('strong', {}, i.title), i.body && h('p', {}, i.body), h('div', { class: 'hint' }, `${i.equipment_id ? (eqName[i.equipment_id] || 'Equipment') + ' · ' : ''}${who[i.created_by] || 'Someone'} · ${fmtDate(i.updated_at)}`),
    can('issues.write') && h('button', { onclick: async () => { try { noteQueued(await mutate('PATCH', `/issues/${i.id}`, { status: i.status === 'open' ? 'resolved' : 'open' }, { label: `${i.status === 'open' ? 'Resolve' : 'Reopen'} “${i.title}”` })); clear(root); render(root); } catch (x) { toast(errMsg(x)); } } }, i.status === 'open' ? 'Mark resolved' : 'Reopen'))));
  if (!issues.length) list.append(h('p', { class: 'hint' }, 'Nothing logged yet.'));
  const f = select([['all', 'All'], ['issue', 'Issues'], ['lesson', 'Lessons learned']], 'all'); f.setAttribute('aria-label', 'Filter'); f.addEventListener('change', () => { kind = f.value; draw(); });
  root.append(h('h1', {}, 'Issues & lessons learned'));
  if (can('issues.write')) {
    const k = select([['issue', 'Issue'], ['lesson', 'Lesson learned']], 'issue'), t = h('input', { maxlength: 160 }), b = h('textarea', { maxlength: 4000 }), e = select([['', 'None'], ...equipment.map(x => [x.id, x.name])], '');
    root.append(h('details', { class: 'card' }, h('summary', {}, 'Log an issue or lesson'), field('Type', k), field('Title', t), field('Details', b), field('Related equipment (optional)', e),
      h('button', { class: 'primary', onclick: async () => { try { const r = await mutate('POST', '/issues', { id: crypto.randomUUID(), kind: k.value, title: t.value, body: b.value, ...(e.value ? { equipment_id: e.value } : {}) }, { label: `Log “${t.value}”` }); if (!noteQueued(r)) toast('Logged.'); clear(root); render(root); } catch (x) { toast(errMsg(x)); } } }, 'Save')));
  }
  root.append(field('Show', f), list); draw();
}
