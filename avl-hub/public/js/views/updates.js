import { h, clear, field, select, fmtDate } from '../dom.js';
import { get, mutate } from '../api.js';
import { can, toast, errMsg, noteQueued } from '../app.js';

const W = ['admin', 'trainer', 'technician'];
const ST = { available: 'Available', scheduled: 'Scheduled', installed_by_human: 'Installed (by a person)', skipped: 'Skipped' };

export async function render(root) {
  const [{ updates }, { equipment }] = await Promise.all([get('/updates'), get('/equipment')]);
  const name = Object.fromEntries(equipment.map(e => [e.id, e.name]));
  root.append(h('h1', {}, 'Update management'), h('div', { class: 'notice' }, 'This page only tracks updates. Nothing is ever installed automatically. Mark “Installed” only after a person has done it.'));
  if (can(...W)) {
    const eq = select(equipment.map(e => [e.id, e.name]), equipment[0]?.id), kind = select([['firmware', 'Firmware'], ['software', 'Software'], ['other', 'Other']], 'firmware');
    const v = h('input', { maxlength: 60 }), n = h('textarea', { maxlength: 2000 }), u = h('input', { placeholder: 'https:// official page (optional)' });
    root.append(h('details', { class: 'card' }, h('summary', {}, 'Record an available update'), field('Equipment', eq), field('Type', kind), field('Version, as published', v),
      field('Notes', n), field('Source link', u), h('button', { class: 'primary', onclick: async () => {
        try { const r = await mutate('POST', '/updates', { id: crypto.randomUUID(), equipment_id: eq.value, kind: kind.value, available_version: v.value, notes: n.value, ...(u.value ? { source_url: u.value } : {}) }, { label: `Record update ${v.value}` }); if (!noteQueued(r)) toast('Recorded.'); clear(root); render(root); } catch (x) { toast(errMsg(x)); } } }, 'Record')));
  }
  root.append(updates.length ? updates.map(x => h('div', { class: 'card' }, h('strong', {}, `${name[x.equipment_id] || 'Equipment'} — ${x.kind} ${x.available_version}`), h('div', { class: 'hint' }, `Recorded ${fmtDate(x.created_at)}`),
    x.notes && h('p', {}, x.notes), x.source_url && h('a', { href: x.source_url }, 'Official page'),
    h('div', { class: 'row' }, h('span', { class: `badge ${x.status === 'installed_by_human' ? 'b-approved' : 'b-draft'}` }, ST[x.status]),
      can(...W) && Object.entries(ST).filter(([k]) => k !== x.status).map(([k, t]) => h('button', { onclick: async () => { try { noteQueued(await mutate('PATCH', `/updates/${x.id}/status`, { status: k }, { label: `Mark ${name[x.equipment_id] || 'equipment'} ${x.available_version} ${t.toLowerCase()}` })); clear(root); render(root); } catch (e) { toast(errMsg(e)); } } }, `Mark ${t.toLowerCase()}`)))))
    : h('p', { class: 'hint' }, 'No updates recorded.'));
}
