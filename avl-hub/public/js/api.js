import { request, ApiError, serverNow } from './http.js';
import * as store from './store.js';
import * as sync from './sync.js';
export { ApiError };

let uid = null;
export const setUser = id => { uid = id; };
const OFFLINE_MSG = 'You appear to be offline. This action needs a connection.';
const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
const fail = r => {
  if (r.status === 401) fire('avl:signed-out');
  if (r.json?.error?.code === 'PASSWORD_CHANGE_REQUIRED') fire('avl:password-change');
  if (r.json?.error?.code === 'MFA_ENROLLMENT_REQUIRED') fire('avl:mfa-enroll');
  return new ApiError(r.status, r.json?.error);
};
const offlineErr = () => new ApiError(0, { code: 'OFFLINE', message: OFFLINE_MSG });

// Direct call (needs a connection). Used for things that cannot be queued: admin actions, uploads, search, AI.
async function call(method, path, body) {
  let r; try { r = await request(method, '/api' + path, body); } catch { sync.markOffline(true); throw offlineErr(); }
  sync.markOffline(false);
  if (!r.ok) throw fail(r);
  return r.json;
}
// Reads: network first, cached copy when offline. Queued (not-yet-synced) changes are layered on top so you always see your own work.
export async function get(path) {
  let r;
  try { r = await request('GET', '/api' + path); }
  catch {
    sync.markOffline(true);
    const hit = uid && await store.cacheGet(`${uid}|${path}`);
    if (hit) return sync.overlay(path, hit.data);
    const s = sync.synth(path); if (s) return sync.overlay(path, s);
    throw offlineErr();
  }
  sync.markOffline(false);
  if (!r.ok) {
    if (r.status === 404) { const s = sync.synth(path); if (s) return sync.overlay(path, s); }
    throw fail(r);
  }
  if (uid) store.cachePut(`${uid}|${path}`, r.json).catch(() => {});
  return sync.overlay(path, r.json);
}
export const post = (p, b = {}) => call('POST', p, b), patch = (p, b = {}) => call('PATCH', p, b), put = (p, b = {}) => call('PUT', p, b), del = p => call('DELETE', p);

// Queueable change. Tries the network now; if offline, saves it on this device to sync later (same key, so it can never apply twice).
// Resolves with the server's response, or { queued: true } when it was saved for later.
export async function mutate(method, path, body, { label = 'Change' } = {}) {
  const key = 'op-' + crypto.randomUUID(), editTime = new Date(serverNow()).toISOString();
  const queue = async () => { await sync.enqueue({ method, path, body, key, editTime, label }); return { queued: true, label }; };
  let r;
  try { r = await request(method, '/api' + path, body, { headers: { 'idempotency-key': key, 'x-edit-time': editTime } }); }
  catch { sync.markOffline(true); return queue(); }
  sync.markOffline(false);
  if (r.status === 401) { const q = await queue(); fire('avl:signed-out'); return q; }      // keep the work; sync after signing in again
  if (!r.ok) throw fail(r);
  if (r.json && r.json.superseded) fire('avl:superseded', label);
  return r.json;
}

// Multipart upload (online only). Fields go BEFORE the file so the server can read them first.
export async function upload(file, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  fd.append('file', file, file.name || 'upload');
  let res;
  try { res = await fetch('/api/files', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-requested-by': 'avl-hub' } }); }
  catch { sync.markOffline(true); throw offlineErr(); }
  let json = null; try { json = await res.json(); } catch { /* none */ }
  if (!res.ok) throw fail({ status: res.status, json });
  return json.file;
}

// Quietly keep the offline copy fresh: everything you could want to read on a job site, fetched in the background.
let warming = false;
export async function warmCache(perms = []) {
  if (warming || !uid) return; warming = true;
  const has = p => perms.includes(p);
  const lim = (a, n) => a.slice(0, n);
  const pool = async (tasks, n = 4) => { const q = [...tasks]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) { try { await q.shift()(); } catch { /* skip */ } } })); };
  try {
    const [eq, mods, panels] = await Promise.all([get('/equipment'), get('/modules'), get('/panels')]);
    const tasks = [() => get('/updates'), () => get('/issues'), () => get('/people'), () => get('/skill-matrix'), () => get('/sources'), () => get(`/progress/${uid}`),
      ...(has('users.manage') ? [() => get('/users')] : []), ...(has('roles.manage') || has('users.manage') ? [() => get('/roles')] : []), ...(has('audit.view') ? [() => get('/audit?limit=50')] : [])];
    for (const e of lim(eq.equipment, 150)) tasks.push(() => get(`/equipment/${e.id}`), () => get(`/equipment/${e.id}/install-steps`), () => get(`/panels?equipment_id=${e.id}`), () => get(`/files?equipment_id=${e.id}&purpose=document`));
    for (const m of lim(mods.modules, 100)) tasks.push(() => get(`/modules/${m.id}`), () => get(`/modules/${m.id}/videos`));
    if (has('progress.view_all')) { const { people } = await get('/people'); for (const x of lim(people, 100)) tasks.push(() => get(`/progress/${x.id}`)); }   // so sign-offs can be prepared offline
    for (const p of lim(panels.panels, 150)) tasks.push(() => get(`/panels/${p.id}`), () => fetch(`/api/files/${p.file_id}`, { credentials: 'same-origin' }).then(r => r.blob()));   // the service worker keeps the photo
    await pool(tasks);
  } catch { /* offline or partial: fine */ } finally { warming = false; }
}
