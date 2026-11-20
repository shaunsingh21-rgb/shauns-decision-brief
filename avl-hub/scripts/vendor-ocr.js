'use strict';
// Copies the OCR engine into public/vendor/ocr so it is served from our own origin (CSP: no third-party scripts).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor', 'ocr');
const nm = p => path.join(root, 'node_modules', p);
const files = [
  ['tesseract.js/dist/tesseract.min.js', 'tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];
try {
  fs.mkdirSync(out, { recursive: true });
  for (const [from, to] of files) fs.copyFileSync(nm(from), path.join(out, to));
  console.log('OCR engine vendored to public/vendor/ocr');
} catch (e) { console.warn('OCR vendoring skipped (' + e.message + '). The wizard will fall back to typing the label text.'); }
