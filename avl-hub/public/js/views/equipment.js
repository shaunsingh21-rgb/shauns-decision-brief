import { h, clear, field, select, provBadge, statusBadge, PROV, fmtDate } from '../dom.js';
import { get, post, patch, put, del, upload } from '../api.js';
import { cleanPhoto, photoPicker } from '../media.js';
import { can, toast, errMsg, navigate } from '../app.js';

const EDIT = ['admin', 'trainer', 'technician'];

export async function render(root, { arg }) {
  return arg ? detail(root, arg) : list(root);
}

async function list(root) {
  const { equipment } = await get('/equipment');
  const q = h('input', { type: 'search', placeholder: 'Search equipment', 'aria-label': 'Search equipment' });
  const out = h('div', { class: 'grid' });
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    clear(out).append(...equipment.filter(e => !t || `${e.name} ${e.manufacturer || ''} ${e.category || ''}`.toLowerCase().includes(t)).map(e =>
      h('a', { class: 'card link', href: `#/equipment/${e.id}` },
        h('strong', {}, e.name), h('div', { class: 'hint' }, [e.manufacturer, e.category].filter(Boolean).join(' · ') || 'No manufacturer listed'),
        h('div', { class: 'row' }, statusBadge(e.status), e.verify_count ? h('span', { class: 'badge b-verify' }, `${e.verify_count} VERIFY`) : null))));
    if (!out.children.length) out.append(h('p', { class: 'hint' }, equipment.length ? 'No matches.' : 'No equipment yet.'));
  };
  q.addEventListener('input', draw); draw();
  root.append(h('div', { class: 'row between' }, h('h1', {}, 'Equipment library'),
    can(...EDIT) && h('a', { class: 'btn primary', href: '#/equipment/new' }, 'Add equipment')),
    h('p', { class: 'hint' }, 'Every value shows where it came from: Manufacturer, Team, AI-drafted, or VERIFY (not confirmed). Nothing is guessed.'), q, out);
}

async function detail(root, id) {
  const [{ equipment: e }, { steps, done }, { updates }, { issues }, { panels }, { files: docs }] = await Promise.all([get(`/equipment/${id}`), get(`/equipment/${id}/install-steps`), get('/updates'), get('/issues'), get(`/panels?equipment_id=${id}`), get(`/files?equipment_id=${id}&purpose=document`)]);
  const reload = () => { clear(root); return detail(root, id); };
  const act = fn => async () => { try { await fn(); await reload(); } catch (x) { toast(errMsg(x)); } };

  const head = h('div', {}, h('p', {}, h('a', { href: '#/equipment' }, '← All equipment')), h('h1', {}, e.name),
    h('div', { class: 'row' }, statusBadge(e.status), h('span', { class: 'hint' }, [e.manufacturer, e.category].filter(Boolean).join(' · '))),
    e.status === 'needs_review' && h('div', { class: 'notice' }, 'This record changed since it was approved, or is waiting for review. It must be approved again.'),
    e.verify_keys.length > 0 && h('div', { class: 'notice' }, `${e.verify_keys.length} item(s) are marked VERIFY: ${e.verify_keys.join(', ')}. Do not rely on them until confirmed from a source.`));

  const specs = h('div', { class: 'card' }, h('h2', {}, 'Specifications'),
    e.fields.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Item', 'Value', 'Source'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, e.fields.map(f => h('tr', {}, h('th', { scope: 'row' }, f.key.replace(/_/g, ' ')),
        h('td', {}, f.provenance === 'verify' ? h('em', {}, 'Not confirmed') : f.value),
        h('td', {}, provBadge(f.provenance), ' ', f.source_url && h('a', { href: f.source_url }, new URL(f.source_url).hostname)))))))
      : h('p', { class: 'hint' }, 'No specifications recorded.'),
    h('div', { class: 'row' }, can(...EDIT) && h('button', { onclick: () => editor(root, e, reload) }, 'Edit'),
      can(...EDIT) && e.status !== 'approved' && e.status !== 'needs_review' && h('button', { onclick: act(() => post(`/equipment/${id}/submit-review`)) }, 'Submit for review'),
      can(...EDIT) && e.status === 'draft' && null));

  const approve = can('admin') && e.status !== 'approved' && approvalPanel(e, id, reload);

  const log = h('div', { class: 'card' }, h('h2', {}, 'Approval history'), e.approvals.length ? h('ul', {}, e.approvals.map(a =>
    h('li', {}, `${fmtDate(a.created_at)}${a.override ? ' — approved with override: ' + a.override_reason : ' — approved'}`))) : h('p', { class: 'hint' }, 'Not approved yet.'));

  const mine = updates.filter(u => u.equipment_id === id), theirs = issues.filter(i => i.equipment_id === id);
  const related = h('div', { class: 'card' }, h('h2', {}, 'Related'),
    h('p', {}, `${mine.length} update record(s) · ${theirs.length} issue/lesson(s). `, h('a', { href: '#/updates' }, 'Updates'), ' · ', h('a', { href: '#/issues' }, 'Issues & lessons')));

  root.append(head, specs, approve, panelsCard(id, panels, reload), docsCard(id, docs, reload), installAssistant(id, steps, done, e), related, log,
    can('admin') && h('p', {}, h('button', { class: 'danger', onclick: async () => { if (confirm('Delete this equipment record?')) { try { await del(`/equipment/${id}`); navigate('#/equipment'); } catch (x) { toast(errMsg(x)); } } } }, 'Delete')));
}

function approvalPanel(e, id, reload) {
  const reason = h('input', { type: 'text', maxlength: 500 });
  const run = async over => {
    try { await post(`/equipment/${id}/approve`, over ? { override: true, override_reason: reason.value } : {}); toast('Approved.'); await reload(); }
    catch (x) { toast(errMsg(x)); }
  };
  if (!e.verify_keys.length) return h('div', { class: 'card' }, h('button', { class: 'primary', onclick: () => run(false) }, 'Approve'));
  return h('div', { class: 'card' }, h('h2', {}, 'Approve'),
    h('div', { class: 'notice' }, `Still VERIFY: ${e.verify_keys.join(', ')}. Resolve these first, or approve with an explicit override.`),
    field('Override reason (required, at least 5 characters)', reason),
    h('p', {}, h('button', { class: 'danger', onclick: () => run(true) }, 'Approve anyway (override)')));
}

function editor(root, e, reload) {
  const rows = e.fields.map(f => ({ ...f, source_url: f.source_url || '' }));
  const removed = [];
  const name = h('input', { value: e.name, maxlength: 120 }), mf = h('input', { value: e.manufacturer || '', maxlength: 120 }), cat = h('input', { value: e.category || '', maxlength: 60 });
  const box = h('div');
  const draw = () => clear(box).append(...rows.map((r, i) => {
    const val = h('input', { value: r.value, 'aria-label': `${r.key} value`, disabled: r.provenance === 'verify', oninput: ev => r.value = ev.target.value });
    const src = h('input', { value: r.source_url, placeholder: 'https:// source (required for Manufacturer)', 'aria-label': `${r.key} source URL`, oninput: ev => r.source_url = ev.target.value });
    const prov = select(Object.entries(PROV), r.provenance); prov.setAttribute('aria-label', `${r.key} source type`);
    prov.addEventListener('change', () => { r.provenance = prov.value; if (r.provenance === 'verify') r.value = ''; draw(); });
    return h('fieldset', {}, h('legend', {}, r.key.replace(/_/g, ' ')), field('Value', val), field('Where it came from', prov), field('Source URL', src),
      h('button', { type: 'button', class: 'danger', onclick: () => { removed.push(r.key); rows.splice(i, 1); draw(); } }, `Remove ${r.key}`));
  }));
  draw();
  const nk = h('input', { placeholder: 'e.g. power_draw', maxlength: 40 });
  const err = h('div', { role: 'alert' });
  clear(root).append(h('h1', {}, `Edit ${e.name}`),
    e.status === 'approved' && h('div', { class: 'notice' }, 'Saving changes will return this record to Needs Review.'),
    field('Name', name), field('Manufacturer', mf), field('Category', cat), h('h2', {}, 'Specifications'), box,
    h('div', { class: 'card' }, field('Add an item (lowercase letters, digits, underscore)', nk), h('button', { type: 'button', onclick: () => {
      const k = nk.value.trim().toLowerCase().replace(/\s+/g, '_'); if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return toast('Use letters, digits and underscore, starting with a letter.');
      if (rows.some(r => r.key === k)) return toast('That item already exists.');
      rows.push({ key: k, value: '', provenance: 'verify', source_url: '' }); nk.value = ''; draw();
    } }, 'Add as VERIFY')), err,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
      try {
        await patch(`/equipment/${e.id}`, { name: name.value, manufacturer: mf.value, category: cat.value, remove_fields: removed.filter(k => !rows.some(r => r.key === k)),
          fields: rows.map(r => ({ key: r.key, provenance: r.provenance, value: r.provenance === 'verify' ? '' : r.value, ...(r.source_url ? { source_url: r.source_url } : {}) })) });
        toast('Saved.'); await reload();
      } catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x), x.data?.details ? ' ' + x.data.details.map(d => d.message).join('; ') : '')); }
    } }, 'Save'), h('button', { onclick: reload }, 'Cancel')));
}

function installAssistant(id, steps, done, e) {
  const doneSet = new Set(done);
  const card = h('div', { class: 'card' }, h('h2', {}, 'Installation assistant'));
  const tally = () => `${doneSet.size} of ${steps.length} done. Your checklist is saved to your account.`;
  const count = h('p', { class: 'hint', role: 'status' }, tally());
  const draw = () => {
    clear(card).append(h('h2', {}, 'Installation assistant'),
      e.status !== 'approved' && steps.length > 0 && h('div', { class: 'notice' }, 'These steps are not approved yet. Confirm them against the manufacturer manual before relying on them.'),
      steps.length ? h('ol', { class: 'plainlist' }, steps.map((s, i) => h('li', { class: 'opt' },
        h('input', { type: 'checkbox', id: `st${i}`, checked: doneSet.has(s.id), disabled: !can(...EDIT), onchange: async ev => {
          ev.target.checked ? doneSet.add(s.id) : doneSet.delete(s.id);
          count.textContent = tally();
          try { await put(`/equipment/${id}/install-progress`, { done: [...doneSet] }); } catch (x) { toast(errMsg(x)); }
        } }),
        h('label', { for: `st${i}`, class: 'plain' }, `${i + 1}. ${s.text} `, provBadge(s.provenance), ' ', s.source_url && h('a', { href: s.source_url }, 'source')))))
        : h('p', { class: 'hint' }, 'No installation steps yet. Add them from the manufacturer manual or your team’s own procedure.'),
      steps.length > 0 && count,
      can(...EDIT) && h('button', { onclick: () => stepEditor(card, id, steps, () => location.reload()) }, 'Edit steps'));
  };
  draw();
  return card;
}

function stepEditor(card, id, steps, after) {
  const rows = steps.map(s => ({ text: s.text, provenance: s.provenance, source_url: s.source_url || '' }));
  const box = h('div'); const err = h('div', { role: 'alert' });
  const draw = () => clear(box).append(...rows.map((r, i) => h('fieldset', {}, h('legend', {}, `Step ${i + 1}`),
    field('Instruction', h('textarea', { maxlength: 600, oninput: ev => r.text = ev.target.value }, r.text)),
    field('Where it came from', Object.assign(select([['team', 'Team'], ['manufacturer', 'Manufacturer'], ['ai', 'AI-drafted']], r.provenance), { onchange: ev => r.provenance = ev.target.value })),
    field('Source URL (required for Manufacturer)', h('input', { value: r.source_url, oninput: ev => r.source_url = ev.target.value })),
    h('button', { type: 'button', class: 'danger', onclick: () => { rows.splice(i, 1); draw(); } }, `Remove step ${i + 1}`))));
  draw();
  clear(card).append(h('h2', {}, 'Edit installation steps'), box, h('button', { type: 'button', onclick: () => { rows.push({ text: '', provenance: 'team', source_url: '' }); draw(); } }, 'Add step'), err,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
      try { await put(`/equipment/${id}/install-steps`, { steps: rows.filter(r => r.text.trim()).map(r => ({ text: r.text, provenance: r.provenance, ...(r.source_url ? { source_url: r.source_url } : {}) })) }); toast('Steps saved.'); after(); }
      catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); }
    } }, 'Save steps'), h('button', { onclick: after }, 'Cancel')));
}

function panelsCard(id, panels, reload) {
  const title = h('input', { maxlength: 120, placeholder: 'e.g. Rear panel' });
  const add = can(...EDIT) && h('div', {}, field('Name for a new photo panel', title), photoPicker(async f => {
    if (!title.value.trim()) { title.focus(); return toast('Give the panel a name first.'); }
    try { const file = await upload(await cleanPhoto(f), { purpose: 'photo', equipment_id: id }); const { panel } = await post('/panels', { equipment_id: id, title: title.value, file_id: file.id }); location.hash = `#/panels/${panel.id}`; }
    catch (x) { toast(errMsg(x)); }
  }, { primary: true }), h('p', { class: 'hint' }, 'Photos are tidied on your device first (location data in the photo is removed).'));
  return h('div', { class: 'card' }, h('h2', {}, 'Photo panels'), panels.length ? h('ul', {}, panels.map(p => h('li', {}, h('a', { href: `#/panels/${p.id}` }, p.title), ` — ${p.pins} pin(s) `, statusBadge(p.status)))) : h('p', { class: 'hint' }, 'No photo panels yet. A panel is a photo with labelled, sourced pins.'), add);
}

function docsCard(id, docs, reload) {
  const pick = h('input', { type: 'file', accept: 'application/pdf', 'aria-label': 'Choose a PDF' });
  return h('div', { class: 'card' }, h('h2', {}, 'Documents'), docs.length ? h('ul', {}, docs.map(d => h('li', {}, h('a', { href: `/api/files/${d.id}` }, d.name), ` (${Math.max(1, Math.round(d.size / 1024))} KB)`,
    can('admin', 'trainer') && [' ', h('button', { class: 'danger', 'aria-label': `Delete ${d.name}`, onclick: async () => { if (confirm(`Delete ${d.name}?`)) { try { await del(`/files/${d.id}`); await reload(); } catch (x) { toast(errMsg(x)); } } } }, 'Delete')]))) : h('p', { class: 'hint' }, 'No documents yet (PDF only).'),
    can(...EDIT) && h('div', { class: 'row' }, pick, h('button', { onclick: async () => { const f = pick.files[0]; if (!f) return toast('Choose a PDF first.'); try { await upload(f, { purpose: 'document', equipment_id: id }); toast('Uploaded.'); await reload(); } catch (x) { toast(errMsg(x)); } } }, 'Upload PDF')));
}
