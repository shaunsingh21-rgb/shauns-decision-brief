import { h, clear, field, select, provBadge, statusBadge, PROV } from '../dom.js';
import { get, post, del, mutate } from '../api.js';
import { can, toast, errMsg, navigate, noteQueued } from '../app.js';

const EDIT = ['admin', 'trainer', 'technician'];
const pct = v => Math.round(v * 100);

export async function render(root, { arg }) {
  const { panel } = await get(`/panels/${arg}`);
  const { equipment } = await get(`/equipment/${panel.equipment_id}`);
  const reload = () => { clear(root); return render(root, { arg }); };
  const state = { selected: null, mode: 'view' };           // view | place | form | quiz
  const stage = h('div', { class: 'stage' });
  const side = h('div');
  const live = h('div', { class: 'vh', role: 'status', 'aria-live': 'polite' });

  const pinBtn = (p, i, { quiz = false, active = false } = {}) => {
    const b = h('button', { type: 'button', class: `pin b-${quiz ? 'team' : p.provenance}${active ? ' active' : ''}`,
      'aria-label': quiz ? `Pin ${i + 1}` : `Pin ${i + 1}: ${p.label || 'not identified (VERIFY)'}. Source: ${PROV[p.provenance]}`,
      onclick: () => { if (!quiz) { state.selected = p.id; state.mode = 'view'; draw(); } } }, String(i + 1));
    b.style.left = `${p.x * 100}%`; b.style.top = `${p.y * 100}%`;                // CSSOM, not an inline style attribute (CSP-safe)
    return b;
  };
  const img = h('img', { src: `/api/files/${panel.file_id}`, alt: `${panel.title}: photo of ${equipment.name}`, draggable: 'false' });

  function draw() {
    clear(stage).append(img);
    if (state.mode === 'quiz') return quiz.draw();
    panel.pins.forEach((p, i) => stage.append(pinBtn(p, i)));
    if (state.mode === 'place') stage.append(state.cross.el);
    clear(side).append(...[state.mode === 'place' ? placeHelp() : state.mode === 'form' ? pinForm() : null,
      state.mode === 'view' ? actions() : null, state.mode === 'view' ? detail() : null, state.mode === 'view' ? pinList() : null].filter(Boolean));
  }

  // ---- keyboard-operable placement: arrows move, Enter places, Escape cancels. Pointer/touch also works. ----
  function startPlace(existing) {
    const pos = { x: existing ? existing.x : 0.5, y: existing ? existing.y : 0.5 };
    const el = h('div', { class: 'cross', tabindex: '0', role: 'group', 'aria-label': 'Pin position marker. Use the arrow keys to move it, Enter to place the pin, Escape to cancel.' });
    const move = () => { el.style.left = `${pos.x * 100}%`; el.style.top = `${pos.y * 100}%`; live.textContent = `Position ${pct(pos.x)} percent across, ${pct(pos.y)} percent down.`; };
    const clamp = v => Math.min(1, Math.max(0, v));
    el.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); pos.x = clamp(pos.x + d[0]); pos.y = clamp(pos.y + d[1]); move(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); done(); }
      else if (e.key === 'Escape') { e.preventDefault(); state.mode = 'view'; draw(); }
    });
    const done = () => { state.draft = { id: existing?.id, x: pos.x, y: pos.y, label: existing?.label || '', note: existing?.note || '', provenance: existing?.provenance || 'team', source_url: existing?.source_url || '' }; state.mode = 'form'; draw(); };
    state.cross = { el, pos, move, done };
    state.mode = 'place'; draw(); move(); el.focus();
  }
  stage.addEventListener('click', e => {
    if (state.mode !== 'place' || e.target.closest('.pin')) return;
    const r = img.getBoundingClientRect(); if (!r.width) return;
    state.cross.pos.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); state.cross.pos.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)); state.cross.done();
  });
  const placeHelp = () => h('div', { class: 'notice' }, h('strong', {}, 'Placing a pin. '), 'Tap the photo, or use the arrow keys on the marker (hold Shift for bigger steps) and press Enter. Press Escape to cancel.',
    h('div', { class: 'row' }, h('button', { onclick: () => state.cross.done() }, 'Place pin here'), h('button', { onclick: () => { state.mode = 'view'; draw(); } }, 'Cancel')));

  function pinForm() {
    const d = state.draft;
    const label = h('input', { value: d.label, maxlength: 120, disabled: d.provenance === 'verify', oninput: e => d.label = e.target.value });
    const note = h('textarea', { maxlength: 1000, oninput: e => d.note = e.target.value }, d.note);
    const prov = select(Object.entries(PROV), d.provenance); prov.addEventListener('change', () => { d.provenance = prov.value; if (d.provenance === 'verify') d.label = ''; pinFormRedraw(); });
    const src = h('input', { value: d.source_url, placeholder: 'https:// page this comes from', oninput: e => d.source_url = e.target.value });
    const xi = h('input', { type: 'number', min: 0, max: 100, value: pct(d.x), oninput: e => d.x = Math.min(1, Math.max(0, +e.target.value / 100)) });
    const yi = h('input', { type: 'number', min: 0, max: 100, value: pct(d.y), oninput: e => d.y = Math.min(1, Math.max(0, +e.target.value / 100)) });
    const err = h('div', { role: 'alert' });
    return h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault(); err.replaceChildren();
      const body = { x: d.x, y: d.y, label: d.provenance === 'verify' ? '' : d.label, note: d.note, provenance: d.provenance, ...(d.source_url ? { source_url: d.source_url } : {}) };
      try { const r = d.id ? await mutate('PATCH', `/pins/${d.id}`, body, { label: `Edit a pin on “${panel.title}”` }) : await mutate('POST', `/panels/${panel.id}/pins`, { id: crypto.randomUUID(), ...body }, { label: `Add a pin to “${panel.title}”` }); if (!noteQueued(r)) toast('Pin saved.'); await reload(); }
      catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); }
    } }, h('h2', {}, d.id ? 'Edit pin' : 'New pin'), field('What is it? (label)', label, d.provenance === 'verify' ? 'Marked VERIFY: not identified yet, so no label.' : 'Use the manufacturer’s name for it.'),
      field('Where this came from', prov), field('Source URL (required for Manufacturer)', src), field('Note (optional)', note),
      h('div', { class: 'row' }, field('Across (%)', xi), field('Down (%)', yi)), err,
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save pin'), h('button', { type: 'button', onclick: () => { state.mode = 'view'; draw(); } }, 'Cancel')));
  }
  const pinFormRedraw = () => { draw(); };

  const detail = () => {
    const p = panel.pins.find(x => x.id === state.selected); if (!p) return h('p', { class: 'hint' }, panel.pins.length ? 'Select a pin to see what it is and where that comes from.' : 'No pins yet.');
    return h('div', { class: 'card', role: 'region', 'aria-label': 'Selected pin' }, h('h2', {}, `Pin ${panel.pins.indexOf(p) + 1}: ${p.label || 'Not identified'}`), h('div', { class: 'row' }, provBadge(p.provenance)),
      p.provenance === 'verify' && h('div', { class: 'notice' }, 'Not identified yet. Do not rely on this pin.'), p.provenance === 'ai' && h('div', { class: 'notice ai' }, 'AI-drafted. Check it against a source.'),
      p.note && h('p', {}, p.note), p.source_url && h('p', {}, 'Source: ', h('a', { href: p.source_url }, new URL(p.source_url).hostname)),
      can(...EDIT) && h('div', { class: 'row' }, h('button', { onclick: () => { state.draft = { ...p, source_url: p.source_url || '' }; state.mode = 'form'; draw(); } }, 'Edit'),
        h('button', { onclick: () => startPlace(p) }, 'Move'), h('button', { class: 'danger', onclick: async () => { try { noteQueued(await mutate('DELETE', `/pins/${p.id}`, undefined, { label: `Delete a pin on “${panel.title}”` })); state.selected = null; await reload(); } catch (x) { toast(errMsg(x)); } } }, 'Delete pin')));
  };
  const pinList = () => h('div', { class: 'card' }, h('h2', {}, 'All pins'), panel.pins.length ? h('ol', {}, panel.pins.map((p, i) => h('li', {}, h('button', { class: 'linkish', onclick: () => { state.selected = p.id; draw(); } }, p.label || 'Not identified'), ' ', provBadge(p.provenance)))) : h('p', { class: 'hint' }, 'None yet.'));

  const run = fn => async () => { try { noteQueued(await fn()); await reload(); } catch (x) { toast(errMsg(x)); } };
  const reason = h('input', { maxlength: 500 });
  const actions = () => h('div', { class: 'card' }, h('div', { class: 'row' },
    can(...EDIT) && h('button', { class: 'primary', onclick: () => startPlace(null) }, 'Add a pin'),
    h('button', { onclick: () => { quiz.start(); } }, 'Quiz me'),
    can(...EDIT) && panel.status === 'draft' && h('button', { onclick: run(() => mutate('POST', `/panels/${panel.id}/submit-review`, {}, { label: `Submit “${panel.title}” for review` })) }, 'Submit for review'),
    can('admin') && panel.status !== 'approved' && !panel.verify_count && h('button', { class: 'primary', onclick: run(() => mutate('POST', `/panels/${panel.id}/approve`, { reviewed_version: panel.version }, { label: `Approve “${panel.title}”` })) }, 'Approve')),
    can('admin') && panel.status !== 'approved' && panel.verify_count > 0 && h('div', {}, h('div', { class: 'notice' }, `${panel.verify_count} pin(s) are still VERIFY. Resolve them, or approve with an explicit override.`),
      field('Override reason (required)', reason), h('button', { class: 'danger', onclick: run(() => mutate('POST', `/panels/${panel.id}/approve`, { override: true, override_reason: reason.value, reviewed_version: panel.version }, { label: `Approve “${panel.title}” (override)` })) }, 'Approve anyway (override)')),
    can('admin') && h('p', {}, h('button', { class: 'danger', onclick: async () => { if (confirm('Delete this panel?')) { try { await del(`/panels/${panel.id}`); navigate(`#/equipment/${panel.equipment_id}`); } catch (x) { toast(errMsg(x)); } } } }, 'Delete panel')));

  // ---- Quiz me: pins from Manufacturer or Team only (never AI or VERIFY); the answer reveals its source ----
  const quiz = (() => {
    let qs = [], i = 0, score = 0, answered = false;
    const pool = () => panel.pins.map((p, idx) => ({ ...p, n: idx })).filter(p => ['manufacturer', 'team'].includes(p.provenance) && p.label);
    const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    return {
      start() {
        const p = pool(); const labels = [...new Set(p.map(x => x.label))];
        if (p.length < 2 || labels.length < 2) return toast('Quiz me needs at least two labelled Manufacturer or Team pins.');
        qs = shuffle(p); i = 0; score = 0; answered = false; state.mode = 'quiz'; draw();
      },
      draw() {
        const q = qs[i]; stage.append(...panel.pins.map((p, idx) => pinBtn(p, idx, { quiz: true, active: idx === q?.n })));
        clear(side);
        if (i >= qs.length) return side.append(h('div', { class: 'card' }, h('h2', {}, 'Done'), h('p', {}, `You got ${score} of ${qs.length}. This practice does not affect sign-off.`),
          h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => quiz.start() }, 'Again'), h('button', { onclick: () => { state.mode = 'view'; draw(); } }, 'Back to the photo'))));
        const others = shuffle([...new Set(pool().map(x => x.label))].filter(l => l !== q.label)).slice(0, 3);
        const opts = shuffle([q.label, ...others]); const fb = h('div', { role: 'status', 'aria-live': 'polite' });
        side.append(h('div', { class: 'card' }, h('h2', {}, `Question ${i + 1} of ${qs.length}`), h('p', {}, `What is at highlighted pin ${q.n + 1}?`),
          h('div', { class: 'column' }, opts.map(o => h('button', { class: 'opt-btn', onclick: ev => {
            if (answered) return; answered = true; const ok = o === q.label; if (ok) score++;
            ev.target.classList.add(ok ? 'right' : 'wrong');
            fb.replaceChildren(h('div', { class: `notice ${ok ? 'ok' : 'bad'}` }, ok ? 'Correct. ' : `Not quite — it’s ${q.label}. `, provBadge(q.provenance), ' ', q.source_url && h('a', { href: q.source_url }, `source: ${new URL(q.source_url).hostname}`)),
              h('button', { class: 'primary', onclick: () => { i++; answered = false; draw(); } }, i + 1 < qs.length ? 'Next' : 'Finish'));
          } }, o))), fb), h('button', { onclick: () => { state.mode = 'view'; draw(); } }, 'Stop'));
      },
    };
  })();

  root.append(h('p', {}, h('a', { href: `#/equipment/${panel.equipment_id}` }, `← ${equipment.name}`)), h('h1', {}, panel.title),
    h('div', { class: 'row' }, statusBadge(panel.status)),
    panel.status !== 'approved' && h('div', { class: 'notice' }, panel.status === 'needs_review' ? 'This panel changed or is waiting for review.' : 'Draft panel: not approved yet.'),
    panel.verify_count > 0 && h('div', { class: 'notice' }, `${panel.verify_count} pin(s) are marked VERIFY (not identified).`), stage, live, side);
  draw();
}
