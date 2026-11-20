'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('../helpers');

const ZERO = '00000000-0000-4000-8000-000000000000';
let h, users, clients;
before(async () => {
  h = await harness();
  users = { admin: await h.makeUser('admin'), trainer: await h.makeUser('trainer'), technician: await h.makeUser('technician'), viewer: await h.makeUser('viewer') };
  clients = {}; for (const r of Object.keys(users)) clients[r] = await h.as(users[r]);
});
after(() => h.close());

const fill = p => p.replace(/:\w+/g, ZERO).replace(/\/sources\/[^/]+$/, p.startsWith('/api/sources/:') ? '/sources/example.com' : '$&');
const mutating = () => h.registry.filter(r => r.method !== 'GET');

test('every route declares access explicitly; only 2 mutating routes are open to any signed-in user', () => {
  assert.ok(h.registry.length > 30);
  const anyMut = mutating().filter(r => r.access === 'any').map(r => `${r.method} ${r.path}`).sort();
  assert.deepEqual(anyMut, ['POST /api/auth/change-password', 'POST /api/auth/logout']);
  const pub = h.registry.filter(r => r.access === 'public').map(r => `${r.method} ${r.path}`);
  assert.deepEqual(pub, ['POST /api/auth/login']);
});

test('unauthenticated calls to every non-public endpoint get 401', async () => {
  const c = h.client();
  for (const r of h.registry.filter(r => r.access !== 'public')) {
    const res = await c.req(r.method, fill(r.path), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    assert.equal(res.status, 401, `${r.method} ${r.path}`);
  }
});

test('403 matrix: every role not listed on a mutating endpoint is refused', async () => {
  let checked = 0;
  for (const r of mutating().filter(r => Array.isArray(r.access))) {
    for (const role of Object.keys(users).filter(x => !r.access.includes(x))) {
      const res = await clients[role].req(r.method, fill(r.path), r.method === 'DELETE' ? undefined : {});
      assert.equal(res.status, 403, `${role} ${r.method} ${r.path} -> ${res.status}`);
      checked++;
    }
  }
  assert.ok(checked > 50, `only ${checked} checks ran`);
});

test('viewer is read-only: every mutating endpoint except logout/change-password is 403', async () => {
  for (const r of mutating().filter(r => Array.isArray(r.access))) {
    const res = await clients.viewer.req(r.method, fill(r.path), r.method === 'DELETE' ? undefined : {});
    assert.equal(res.status, 403, `viewer ${r.method} ${r.path}`);
  }
});

test('technician and viewer get 403 on admin read endpoints', async () => {
  for (const role of ['technician', 'viewer', 'trainer'])
    for (const p of ['/api/users', '/api/audit']) assert.equal((await clients[role].get(p)).status, 403, `${role} ${p}`);
  assert.equal((await clients.admin.get('/api/users')).status, 200);
});

test('requests without the CSRF header are rejected', async () => {
  const res = await clients.admin.req('POST', '/api/sources', { domain: 'example.com' }, { csrf: false });
  assert.equal(res.status, 403); assert.equal(res.body.error.code, 'CSRF');
});

test('unknown endpoints and malformed JSON are handled without leaking details', async () => {
  assert.equal((await clients.admin.get('/api/nope')).status, 404);
  const bad = await fetch(h.base + '/api/sources', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-by': 'avl-hub', cookie: clients.admin.cookie }, body: '{oops' });
  assert.equal(bad.status, 400);
});

test('security headers: CSP present, no X-Powered-By', async () => {
  const res = await fetch(h.base + '/healthz');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});
