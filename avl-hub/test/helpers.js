'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createApp } = require('../server');

const PW = 'Sample-Passw0rd-123';
async function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avl-test-'));
  const h = createApp({ dbPath: path.join(dir, 't.db'), uploadDir: path.join(dir, 'up'), loginIpMax: 10000, apiRateMax: 100000,
    lockoutMaxFailures: 3, lockoutMinutes: 15, argon: { memoryCost: 1024, timeCost: 2, parallelism: 1 }, ...overrides });
  const server = await new Promise(r => { const s = h.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { db } = h.ctx;

  async function makeUser(role, username = `${role}-${crypto.randomBytes(3).toString('hex')}`, { mustChange = false, password = PW } = {}) {
    const id = crypto.randomUUID(), now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id,username,display_name,role,password_hash,must_change_password,auth_provider,created_at,updated_at) VALUES (?,?,?,?,?,?,'local',?,?)`)
      .run(id, username, `Sample ${username}`, role, await h.ctx.auth.provider.hashPassword(password), +mustChange, now, now);
    return { id, username, role, password };
  }
  // Minimal cookie-jar client. Always sends the CSRF header unless told otherwise.
  function client() {
    let cookie = '';
    const c = {
      async req(method, p, body, { csrf = true } = {}) {
        const res = await fetch(base + p, { method, redirect: 'manual',
          headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-requested-by': 'avl-hub' } : {}), ...(cookie ? { cookie } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined });
        const sc = res.headers.getSetCookie?.() || [];
        for (const s of sc) { const [kv] = s.split(';'); if (/=;?$/.test(kv) || /Expires=Thu, 01 Jan 1970/i.test(s)) cookie = ''; else cookie = kv; }
        let json = null; try { json = await res.json(); } catch {}
        return { status: res.status, body: json, setCookie: sc };
      },
      async upload(fields, bytes, filename = 'x.bin', type = 'application/octet-stream', { csrf = true } = {}) {
        const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v);       // purpose first, like the browser client
        fd.append('file', new Blob([bytes], { type }), filename);
        const res = await fetch(base + '/api/files', { method: 'POST', body: fd, headers: { ...(csrf ? { 'x-requested-by': 'avl-hub' } : {}), ...(cookie ? { cookie } : {}) } });
        let json = null; try { json = await res.json(); } catch {} return { status: res.status, body: json };
      },
      async raw(p, headers = {}) { const r = await fetch(base + p, { headers: { ...(cookie ? { cookie } : {}), ...headers } }); return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) }; },
      get: (p) => c.req('GET', p), post: (p, b = {}) => c.req('POST', p, b), patch: (p, b = {}) => c.req('PATCH', p, b), put: (p, b = {}) => c.req('PUT', p, b), del: (p) => c.req('DELETE', p),
      async login(u, password = PW) { return c.post('/api/auth/login', { username: u.username || u, password }); },
      get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    };
    return c;
  }
  async function as(user) { const c = client(); const r = await c.login(user); if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.body)); return c; }
  return { ...h, base, db, makeUser, client, as, PW,
    async close() { await new Promise(r => server.close(r)); h.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { harness, PW };
