// Safe DOM builder. Text is ALWAYS inserted as text nodes (never innerHTML), so API data cannot inject markup.
// Native append() prints `false` and `[object HTMLDivElement]` for empty values and arrays. Everything in this app builds DOM from
// expressions like `cond && h(...)` and `items.map(...)`, so append() is made to skip empties and flatten arrays, like h() does.
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...kids) { return nativeAppend.apply(this, kids.flat(Infinity).filter(k => k != null && k !== false && k !== true)); };

const SAFE_URL = /^(#|\/(?!\/)|https:\/\/)/i;
// Inline pictures made by our own server (the two-step QR code). Raster formats only: never SVG, which can carry script.
const DATA_IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if ((k === 'href' || k === 'src') && !SAFE_URL.test(String(v)) && !(tag === 'img' && k === 'src' && DATA_IMG.test(String(v)))) continue;   // drops javascript:, http:, and data: except raster images
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  if (tag === 'a' && el.getAttribute('href')?.startsWith('https://')) el.rel = 'noopener noreferrer', el.target = '_blank';
  const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) return k.forEach(add); el.append(k instanceof Node ? k : document.createTextNode(String(k))); };
  kids.forEach(add);
  return el;
}
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const fmtDate = s => s ? new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';

export const PROV = { manufacturer: 'Manufacturer', team: 'Team', ai: 'AI-drafted', verify: 'VERIFY' };
export const STATUS = { draft: 'Draft', needs_review: 'Needs Review', approved: 'Approved' };
export const provBadge = p => h('span', { class: `badge b-${p}`, title: p === 'ai' ? 'Drafted by AI. Needs human review.' : p === 'verify' ? 'Not confirmed. Do not rely on this.' : '' }, PROV[p] || p);
export const statusBadge = s => h('span', { class: `badge b-${s}` }, STATUS[s] || s);

// Field helpers that always carry a visible label.
export function field(label, input, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 9);
  input.id = id;
  return h('div', {}, h('label', { for: id }, label), input, hint && h('div', { class: 'hint' }, hint));
}
export function select(options, value) {
  return h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
}
