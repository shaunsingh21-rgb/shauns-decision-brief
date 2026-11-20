import { h } from './dom.js';

// Re-encodes a phone photo to a plain JPEG: applies its rotation, caps the size, and drops EXIF data (such as GPS location).
export async function cleanPhoto(file, max = 2000) {
  if (!/^image\//.test(file.type)) throw new Error('Please choose a photo.');
  if (file.size > 25e6) throw new Error('That photo is too large.');
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('This photo format can’t be read here. Try a JPEG or PNG.'); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Could not prepare the photo.');
  return new File([blob], (file.name || 'photo').replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
}

export const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export function parseTime(t) {
  const m = /^(\d{1,3}):([0-5]?\d)$/.exec(t.trim()); if (m) return +m[1] * 60 + +m[2];
  return /^\d{1,5}$/.test(t.trim()) ? +t.trim() : null;
}
// A camera/library picker button that is a real <label> around a visually-hidden file input (keyboard and screen-reader friendly).
export function photoPicker(onFile, { primary = false, camera = true } = {}) {
  const mk = (text, capture) => h('label', { class: `btn nolabel${primary && capture ? ' primary' : ''}` }, text,
    h('input', { type: 'file', accept: 'image/*', ...(capture ? { capture: 'environment' } : {}), class: 'vh', onchange: e => { const f = e.target.files[0]; e.target.value = ''; if (f) onFile(f); } }));
  return h('span', { class: 'row' }, camera && mk('Take photo', true), mk('Choose photo', false));
}
