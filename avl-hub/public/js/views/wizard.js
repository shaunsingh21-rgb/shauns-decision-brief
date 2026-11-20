import { h, clear, field, select, provBadge, PROV } from '../dom.js';
import { get, post } from '../api.js';
import { toast, errMsg, navigate } from '../app.js';

const STEPS = ['Photo', 'Confirm', 'Research', 'Review'];
const SUGGESTED = ['power', 'inputs', 'outputs', 'connectivity', 'dimensions', 'firmware_version'];   // start as VERIFY — never guessed

export async function render(root) {
  const w = { step: 0, text: '', name: '', manufacturer: '', category: '', fields: [], results: null, snippets: [], draft: null, photoUrl: null };
  const draw = () => {
    clear(root).append(h('p', {}, h('a', { href: '#/equipment' }, '← Cancel')), h('h1', {}, 'Add equipment'),
      h('ol', { class: 'steps', 'aria-label': 'Progress' }, STEPS.map((s, i) => h('li', { 'aria-current': i === w.step ? 'step' : null }, `${i + 1}. ${s}`))),
      [stepPhoto, stepConfirm, stepResearch, stepReview][w.step](w, draw));
  };
  draw();
}

const nav = (w, draw, { next = 'Next', ok = () => true } = {}) => h('div', { class: 'row' },
  w.step > 0 && h('button', { type: 'button', onclick: () => { w.step--; draw(); } }, 'Back'),
  w.step < 3 && h('button', { type: 'button', class: 'primary', onclick: () => { if (ok()) { w.step++; draw(); } } }, next));

// ---- 1. Photo + OCR (OCR runs in the browser; the photo is not uploaded) ----
function stepPhoto(w, draw) {
  const status = h('p', { class: 'hint', role: 'status' });
  const ta = h('textarea', { rows: 6, maxlength: 6000, oninput: e => w.text = e.target.value }, w.text);
  const preview = h('div', {});
  if (w.photoUrl) preview.append(h('img', { src: w.photoUrl, alt: 'Photo of the equipment label', class: 'preview' }));
  const onFile = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || f.size > 15e6) return toast('Please choose a JPEG, PNG or WebP photo under 15 MB.');
    if (w.photoUrl) URL.revokeObjectURL(w.photoUrl);
    w.photoUrl = URL.createObjectURL(f); w.file = f;
    clear(preview).append(h('img', { src: w.photoUrl, alt: 'Photo of the equipment label', class: 'preview' }));
    await runOcr(w, status, ta);
  };
  return h('div', {},
    h('p', {}, 'Take a photo of the nameplate or label, or type what it says. The text is read on your device; the photo is not sent anywhere.'),
    h('div', { class: 'row' },
      h('label', { class: 'btn primary nolabel' }, 'Take photo', h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'vh', onchange: onFile })),
      h('label', { class: 'btn nolabel' }, 'Choose photo', h('input', { type: 'file', accept: 'image/*', class: 'vh', onchange: onFile }))),
    preview, status, field('Text from the label (edit to correct it)', ta, 'Automatic reading can make mistakes. You confirm it in the next step.'),
    nav(w, draw, { ok: () => true }));
}

function loadScript(src) {
  return new Promise((res, rej) => { if (window.Tesseract) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('OCR engine not available')); document.head.append(s); });
}
async function downscale(file, max = 1800) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c;
}
async function runOcr(w, status, ta) {
  status.textContent = 'Reading the label…';
  try {
    await loadScript('/vendor/ocr/tesseract.min.js');
    const worker = await window.Tesseract.createWorker('eng', 1, { workerPath: '/vendor/ocr/worker.min.js', corePath: '/vendor/ocr', langPath: '/vendor/ocr', gzip: true, workerBlobURL: false });
    const { data } = await worker.recognize(await downscale(w.file)); await worker.terminate();
    w.text = data.text.trim(); ta.value = w.text;
    status.textContent = w.text ? 'Done. Check the text below and fix any mistakes.' : 'No text found. Type what the label says.';
  } catch { status.textContent = 'Automatic reading is not available here. Please type what the label says.'; }
}

// ---- 2. Confirm ----
function stepConfirm(w, draw) {
  const name = h('input', { value: w.name, maxlength: 120, required: true, oninput: e => w.name = e.target.value });
  const mf = h('input', { value: w.manufacturer, maxlength: 120, oninput: e => w.manufacturer = e.target.value });
  const cat = h('input', { value: w.category, maxlength: 60, oninput: e => w.category = e.target.value });
  const ta = h('textarea', { rows: 5, maxlength: 6000, oninput: e => w.text = e.target.value }, w.text);
  return h('div', {}, h('div', { class: 'notice' }, 'Confirm what the label says. Only what you confirm here is used for searching and drafting.'),
    field('Equipment name / model', name), field('Manufacturer', mf), field('Category (optional)', cat), field('Label text you confirm', ta),
    nav(w, draw, { ok: () => w.name.trim().length > 0 || (toast('Enter the equipment name or model.'), name.focus(), false) }));
}

// ---- 3. Research (server-side; official sources only) ----
function stepResearch(w, draw) {
  const out = h('div'); const aiOut = h('div');
  const drawResults = () => {
    clear(out);
    if (!w.results) return;
    if (!w.results.length) out.append(h('p', { class: 'hint' }, 'No results on the official domains. You can still continue and mark items VERIFY.'));
    w.results.forEach(r => {
      const key = h('input', { placeholder: 'item, e.g. power', 'aria-label': 'Item name', maxlength: 40 }), val = h('input', { placeholder: 'value as written on that page', 'aria-label': 'Value as written on the page', maxlength: 2000 });
      const inc = h('input', { type: 'checkbox', id: 'inc' + r.url, checked: w.snippets.includes(r.snippet), onchange: e => { w.snippets = e.target.checked ? [...w.snippets, r.snippet] : w.snippets.filter(s => s !== r.snippet); } });
      out.append(h('div', { class: 'card' }, h('strong', {}, r.title), h('div', { class: 'hint' }, r.host), h('p', {}, r.snippet), h('a', { href: r.url }, 'Open official page'),
        h('div', { class: 'opt' }, inc, h('label', { for: 'inc' + r.url, class: 'plain' }, 'Use this snippet as context for the AI draft')),
        h('div', { class: 'row' }, key, val, h('button', { type: 'button', onclick: () => {
          const k = key.value.trim().toLowerCase().replace(/\s+/g, '_'); if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || !val.value.trim()) return toast('Type an item name and the value as written on the page.');
          addField(w, { key: k, value: val.value.trim(), provenance: 'manufacturer', source_url: r.url }); key.value = val.value = ''; toast(`Added ${k} (Manufacturer).`);
        } }, 'Add as Manufacturer item'))));
    });
  };
  drawResults();
  const search = h('button', { type: 'button', onclick: async e => {
    e.target.disabled = true; out.replaceChildren(h('p', { class: 'hint', role: 'status' }, 'Searching official sources…'));
    try { w.results = (await post('/research', { query: [w.manufacturer, w.name].filter(Boolean).join(' ') })).results; drawResults(); }
    catch (x) { out.replaceChildren(h('div', { class: 'notice' }, errMsg(x), ' You can skip this step.')); }
    e.target.disabled = false;
  } }, 'Search official sources');
  const drawDraft = () => {
    clear(aiOut); if (!w.draft) return;
    aiOut.append(h('div', { class: 'notice ai' }, h('strong', {}, 'AI-drafted — not verified. '), 'Check it against a source before approving.', h('p', {}, w.draft.summary),
      w.draft.unknown.length ? h('p', {}, 'The AI could not find: ', w.draft.unknown.join(', '), '. These will be marked VERIFY.') : null,
      h('button', { type: 'button', onclick: () => { if (w.draft.summary) addField(w, { key: 'ai_notes', value: w.draft.summary, provenance: 'ai' }); w.draft.unknown.forEach(u => { const k = u.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); if (/^[a-z]/.test(k)) addField(w, { key: k, value: '', provenance: 'verify' }); }); toast('Added to the review list.'); } }, 'Add to review list')));
  };
  drawDraft();
  const draft = h('button', { type: 'button', onclick: async e => {
    e.target.disabled = true;
    try { w.draft = (await post('/ai/draft', { source_text: [w.text, ...w.snippets].filter(Boolean).join('\n\n').slice(0, 6000) || `${w.manufacturer} ${w.name}` })).draft; drawDraft(); }
    catch (x) { aiOut.replaceChildren(h('div', { class: 'notice' }, errMsg(x))); }
    e.target.disabled = false;
  } }, 'Draft a description with AI');
  return h('div', {}, h('p', {}, 'Look up the manufacturer’s own documents. Only sites your administrator has listed as official are searched.'), search, out,
    h('h2', {}, 'AI draft (optional)'), h('p', { class: 'hint' }, 'The AI only rewrites the text you confirmed and the snippets you ticked. It is always labelled and never approved automatically.'), draft, aiOut,
    nav(w, draw, { next: 'Review' }));
}

function addField(w, f) { const i = w.fields.findIndex(x => x.key === f.key); if (i >= 0) w.fields[i] = f; else w.fields.push(f); }

// ---- 4. Review ----
function stepReview(w, draw) {
  SUGGESTED.forEach(k => { if (!w.fields.some(f => f.key === k)) w.fields.push({ key: k, value: '', provenance: 'verify' }); });
  const err = h('div', { role: 'alert' });
  const rows = w.fields.map(f => {
    const val = h('input', { value: f.value, disabled: f.provenance === 'verify', 'aria-label': `${f.key} value`, oninput: e => f.value = e.target.value });
    const sel = select(Object.entries(PROV).filter(([k]) => k !== 'manufacturer' || f.source_url), f.provenance); sel.setAttribute('aria-label', `${f.key} source type`);
    sel.addEventListener('change', () => { f.provenance = sel.value; if (f.provenance === 'verify') f.value = ''; draw(); });
    return h('tr', {}, h('th', { scope: 'row' }, f.key.replace(/_/g, ' ')), h('td', {}, val), h('td', {}, provBadge(f.provenance), ' ', f.source_url && h('a', { href: f.source_url }, new URL(f.source_url).hostname), sel));
  });
  const save = async submit => {
    err.replaceChildren();
    try {
      const body = { name: w.name, manufacturer: w.manufacturer || undefined, category: w.category || undefined,
        fields: w.fields.filter(f => f.provenance === 'verify' || f.value.trim()).map(f => ({ key: f.key, provenance: f.provenance, value: f.provenance === 'verify' ? '' : f.value.trim(), ...(f.source_url ? { source_url: f.source_url } : {}) })) };
      const { equipment } = await post('/equipment', body);
      if (submit) await post(`/equipment/${equipment.id}/submit-review`);
      toast(submit ? 'Saved and submitted for review.' : 'Saved as a draft.'); navigate(`#/equipment/${equipment.id}`);
    } catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x), x.data?.details ? ' ' + x.data.details.map(d => d.message).join('; ') : '')); }
  };
  return h('div', {}, h('h2', {}, w.name), h('div', { class: 'notice' }, 'Anything left as VERIFY is saved as “not confirmed”. Nothing is filled in by guessing.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Item', 'Value', 'Source'].map(t => h('th', { scope: 'col' }, t)))), h('tbody', {}, rows))), err,
    h('div', { class: 'row' }, nav(w, draw), h('button', { type: 'button', onclick: () => save(false) }, 'Save as draft'), h('button', { type: 'button', class: 'primary', onclick: () => save(true) }, 'Save and submit for review')));
}
