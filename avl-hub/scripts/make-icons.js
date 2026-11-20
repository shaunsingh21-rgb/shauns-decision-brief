'use strict';
// Regenerates public/icons/*.png from an inline SVG (dev tool; the PNGs are committed). Uses the Playwright already installed for tests.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#104d3a"/>
<g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)"><rect x="96" y="150" width="320" height="212" rx="26" fill="none" stroke="#fff" stroke-width="22"/>
<circle cx="190" cy="256" r="34" fill="#b6f1d4"/><rect x="250" y="226" width="120" height="16" rx="8" fill="#fff"/><rect x="250" y="270" width="84" height="16" rx="8" fill="#fff"/></g></svg>`;
(async () => {
  const out = path.join(__dirname, '..', 'public', 'icons'); const b = await chromium.launch(); const p = await b.newPage();
  for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 0.22], ['apple-touch-icon.png', 180, 0]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0}svg{width:${size}px;height:${size}px;display:block}</style>${svg(pad)}`);
    fs.writeFileSync(path.join(out, name), await p.screenshot({ type: 'png' }));
  }
  await b.close(); console.log('icons written');
})();
