'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('../helpers');
const { KEYS, CATALOGUE, SYSTEM_ROLES } = require('../../server/lib/permissions');
const makeApi = require('../../server/api');

const ZERO = '00000000-0000-4000-8000-000000000000';
let h, clients;
const fill = p => p.replace(/:domain/, 'example.com').replace(/:\w+/g, ZERO);
const body = r => (r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
const mutating = () => h.registry.filter(r => r.method !== 'GET');
const needs = r => (r.access && r.access.permissions) || null;

before(async () => {
  h = await harness();
  clients = {};
  for (const role of ['admin', 'trainer', 'technician', 'viewer']) clients[role] = await h.as(await h.makeUser(role));
});
after(() => h.close());

test('every route declares its access; only sign-out, change-password and the two-step self-service routes are open to any signed-in user', () => {
  assert.ok(h.registry.length > 40);
  const anyMut = mutating().filter(r => r.access === 'any').map(r => `${r.method} ${r.path}`).sort();
  assert.deepEqual(anyMut, ['POST /api/auth/change-password', 'POST /api/auth/logout', 'POST /api/auth/mfa/disable', 'POST /api/auth/mfa/enable', 'POST /api/auth/mfa/recovery-codes', 'POST /api/auth/mfa/setup']);
  assert.deepEqual(h.registry.filter(r => r.access === 'public').map(r => `${r.method} ${r.path}`), ['POST /api/auth/login', 'POST /api/auth/mfa/verify']);
  for (const r of h.registry) assert.ok(r.access === 'public' || r.access === 'any' || (needs(r) && needs(r).every(p => KEYS.includes(p))), `${r.method} ${r.path} has a bad access declaration`);
});

test('the app refuses to start if a route names a permission that does not exist (typos cannot silently open a route)', () => {
  const api = makeApi();
  assert.throws(() => api.post('/x', api.P('equipment.eddit'), () => {}), /must declare access/);
  assert.throws(() => api.post('/x', { permissions: [] }, () => {}), /must declare access/);
  assert.throws(() => api.post('/x', ['admin'], () => {}), /must declare access/);
  assert.doesNotThrow(() => api.post('/x', api.P('equipment.edit'), () => {}));
});

test('unauthenticated calls to every non-public endpoint get 401', async () => {
  const c = h.client();
  for (const r of h.registry.filter(r => r.access !== 'public')) assert.equal((await c.req(r.method, fill(r.path), body(r))).status, 401, `${r.method} ${r.path}`);
});

test('PERMISSION MATRIX: a role holding every permission EXCEPT the ones a route needs is refused (403) on every permissioned route', async () => {
  const cache = new Map(); let checked = 0;
  for (const r of h.registry.filter(x => needs(x))) {
    const key = [...needs(r)].sort().join('|');
    if (!cache.has(key)) cache.set(key, await h.as(await h.makeUser(h.makeRole(KEYS.filter(k => !needs(r).includes(k))))));
    const res = await cache.get(key).req(r.method, fill(r.path), body(r));
    assert.equal(res.status, 403, `${r.method} ${r.path} should need ${needs(r)} (got ${res.status})`); checked++;
  }
  assert.ok(checked > 50, `only ${checked} checks ran`);
});

test('PERMISSION MATRIX: a role holding ONLY the needed permission is let through (the request then fails on its own merits, never 401/403)', async () => {
  const cache = new Map(); let checked = 0;
  for (const r of h.registry.filter(x => needs(x))) {
    const only = needs(r)[0];
    if (!cache.has(only)) cache.set(only, await h.as(await h.makeUser(h.makeRole([only]))));
    const res = await cache.get(only).req(r.method, fill(r.path), body(r));
    assert.ok(![401, 403].includes(res.status), `${r.method} ${r.path} refused a role that holds ${only} (got ${res.status}: ${JSON.stringify(res.body)})`); checked++;
  }
  assert.ok(checked > 50);
});

test('every permission in the catalogue is actually used by at least one route, so none is decorative', () => {
  const used = new Set(h.registry.flatMap(r => needs(r) || []));
  // 'progress.view_all' and 'issues.manage' are enforced inside handlers (who may see/edit what), not at the route door
  const inHandler = new Set(['progress.view_all', 'issues.manage', 'training.author']);
  for (const p of CATALOGUE.map(c => c.key)) assert.ok(used.has(p) || inHandler.has(p), `${p} is never enforced`);
});

test('the built-in roles in the database match the defaults in the code (so "reset to defaults" is truthful)', () => {
  for (const [id, def] of Object.entries(SYSTEM_ROLES)) {
    const row = h.db.prepare('SELECT * FROM roles WHERE id=?').get(id); assert.ok(row && row.is_system, id);
    if (id === 'admin') continue;                                              // admin is computed: always everything
    assert.deepEqual(h.db.prepare('SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission').all(id).map(r => r.permission), [...def.permissions].sort(), id);
  }
});

test('built-in roles behave exactly as before roles became editable', async () => {
  const eq = async c => c.post('/api/equipment', { name: 'SAMPLE x', fields: [] });
  assert.equal((await eq(clients.viewer)).status, 403); assert.equal((await eq(clients.technician)).status, 201); assert.equal((await eq(clients.trainer)).status, 201);
  const e = (await eq(clients.admin)).body.equipment;
  for (const role of ['technician', 'trainer', 'viewer']) assert.equal((await clients[role].post(`/api/equipment/${e.id}/approve`, {})).status, 403, `${role} cannot approve`);
  assert.equal((await clients.admin.post(`/api/equipment/${e.id}/approve`, {})).status, 200);
  assert.equal((await clients.trainer.post('/api/modules', { title: 'SAMPLE', level: 1 })).status, 201); assert.equal((await clients.technician.post('/api/modules', { title: 'SAMPLE', level: 1 })).status, 403);
  for (const role of ['trainer', 'technician', 'viewer']) for (const p of ['/api/users', '/api/audit', '/api/roles', '/api/admin/export']) assert.equal((await clients[role].get(p)).status, 403, `${role} ${p}`);
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
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/); assert.match(res.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});
