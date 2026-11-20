'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');

// Output escaping is enforced structurally: the client must never build markup from strings.
const BANNED = [/\bstyle\s*:\s*['"`]/, /\.style\.cssText/, /setAttribute\(\s*['"]style/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\s*\(/, /setTimeout\s*\(\s*['"`]/, /dangerouslySet/];
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); }

test('client code uses no HTML-string injection or eval', () => {
  const files = walk(path.join(__dirname, '..', '..', 'public', 'js')).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 10);
  for (const f of files) { const s = fs.readFileSync(f, 'utf8'); for (const re of BANNED) assert.ok(!re.test(s), `${path.relative(process.cwd(), f)} matches ${re}`); }
});
test('index.html has no inline script, inline style or event-handler attributes; no third-party origins', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(s)); assert.ok(!/\sstyle=/i.test(s)); assert.ok(!/\son\w+=/i.test(s)); assert.ok(!/(src|href)="https?:\/\//i.test(s));
});
test('no API keys or secrets referenced in client code', () => {
  for (const f of walk(path.join(__dirname, '..', '..', 'public', 'js'))) assert.ok(!/BRAVE|ANTHROPIC|api[_-]?key|x-subscription-token/i.test(fs.readFileSync(f, 'utf8')), f);
});

test('every client module parses as an ES module', () => {
  const { execFileSync } = require('child_process'), os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-syntax-'));
  for (const f of walk(path.join(__dirname, '..', '..', 'public', 'js')).filter(f => f.endsWith('.js'))) {
    const copy = path.join(tmp, 'm.mjs'); fs.copyFileSync(f, copy);
    try { execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }); } catch (e) { assert.fail(`${path.basename(f)}: ${e.stderr.toString().split('\n').slice(0, 4).join(' | ')}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
