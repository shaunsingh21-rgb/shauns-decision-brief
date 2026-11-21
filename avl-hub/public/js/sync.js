// The sync queue. Changes made offline wait here and are sent in order when the connection returns.
//  - Every queued change has a key, so re-sending after a lost response never applies it twice.
//  - Normal edits are last-writer-wins PER RECORD, decided by when the edit was MADE (the server does the deciding).
//  - Sign-offs, approvals, quiz attempts and scores are append-only events: never merged, never overwritten, always attributed to the signed-in user by the server.
//  - If the server refuses a queued change, it is kept visibly as "needs attention" — never silently dropped.
import { request, serverNow } from './http.js';
import * as store from './store.js';

const S = { userId: null, ops: [], syncing: false, offline: false, lastSync: null, notices: [], needSignIn: false, timer: null };
const subs = new Set();
const emit = () => { const s = status(); subs.forEach(f => f(s)); };
export const subscribe = f => { subs.add(f); f(status()); return () => subs.delete(f); };
export const pendingOps = () => S.ops.filter(o => o.status === 'pending');
export const allOps = () => [...S.ops];
export const notices = () => [...S.notices];
export function status() {
  const pending = S.ops.filter(o => o.status === 'pending').length, attention = S.ops.filter(o => o.status === 'rejected').length;
  return { pending, attention, syncing: S.syncing, offline: S.offline, needSignIn: S.needSignIn, lastSync: S.lastSync, notices: S.notices.length };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function statusText(s) {
  if (s.needSignIn && s.pending) return `Sign in again to sync ${plural(s.pending, 'change')}`;
  if (s.attention) return `${plural(s.attention, 'change')} need${s.attention === 1 ? 's' : ''} attention`;
  if (s.syncing) return 'Syncing…';
  if (s.offline) return s.pending ? `Offline — ${plural(s.pending, 'change')} waiting to sync` : 'Offline — showing saved data';
  if (s.pending) return `${plural(s.pending, 'change')} waiting to sync`;
  return 'All changes saved';
}
export const statusLevel = s => (s.attention || s.needSignIn ? 'bad' : s.pending || s.offline || s.syncing ? 'warn' : 'ok');

export async function init(userId) {
  if (S.userId === userId) return;
  S.userId = userId;
  S.ops = (await store.outboxList()).filter(o => o.userId === userId);
  const saved = await store.metaGet('notices:' + userId); S.notices = Array.isArray(saved) ? saved.filter(n => n && typeof n.text === 'string') : [];       // ignore damaged saved data
  S.lastSync = (await store.metaGet('lastSync:' + userId)) || null;
  if (!S.timer) {
    // Every few seconds: if we think we are offline, check; otherwise send anything waiting. (So "Offline — N waiting" clears itself soon after the signal returns.)
    S.timer = setInterval(() => { if (!S.userId) return; if (S.offline) probe(); else if (pendingOps().length && !S.syncing) flush(); }, 8000);
    window.addEventListener('online', probe); window.addEventListener('offline', () => markOffline(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') probe(); });
  }
  emit(); if (pendingOps().length) flush();
}
export async function reset() { S.userId = null; S.ops = []; S.notices = []; S.lastSync = null; S.offline = false; S.needSignIn = false; emit(); }
async function probe() { try { await request('GET', '/healthz', undefined, { timeout: 6000 }); markOffline(false); } catch { markOffline(true); } }
export function markOffline(v) { if (S.offline !== v) { S.offline = v; emit(); if (!v && S.userId) flush(); } }

export async function enqueue(op) {
  const rec = { ...op, userId: S.userId, status: 'pending', attempts: 0, createdAt: new Date(serverNow()).toISOString() };
  rec.seq = await store.outboxAdd(rec); S.ops.push(rec); emit(); return rec;
}
async function remove(op) { await store.outboxDelete(op.seq); S.ops = S.ops.filter(o => o.seq !== op.seq); }
async function addNotice(n) { S.notices.push({ ...n, at: new Date().toISOString() }); await store.metaSet('notices:' + S.userId, S.notices); }
export async function dismissNotices() { S.notices = []; await store.metaSet('notices:' + S.userId, []); emit(); }
export async function discard(seq) { const op = S.ops.find(o => o.seq === seq); if (op) { await remove(op); emit(); } }
export async function retry(seq) {
  const op = S.ops.find(o => o.seq === seq); if (!op) return;
  Object.assign(op, { status: 'pending', error: null, errorMissing: null, attempts: 0, key: 'op-' + crypto.randomUUID() }); await store.outboxPut(op); emit(); flush();
}

// Only one tab sends at a time (Web Locks), and each change is re-read from storage just before it is sent, so a change that was
// discarded or already sent in another tab is never sent again.
const withLock = fn => (navigator.locks && navigator.locks.request ? navigator.locks.request('avl-flush', fn) : fn());
export async function flush() {
  if (S.syncing || !S.userId) return;
  if (!pendingOps().length) return;
  S.syncing = true; S.needSignIn = false; emit();
  let progressed = false, halted = false;
  try { await withLock(async () => {
    S.ops = (await store.outboxList()).filter(o => o.userId === S.userId); emit();
    for (const op of pendingOps()) {
      const fresh = await store.outboxGet(op.seq); if (!fresh || fresh.status !== 'pending') { S.ops = S.ops.filter(o => o.seq !== op.seq); continue; }
      let r;
      try { r = await request(op.method, '/api' + op.path, op.body, { headers: { 'idempotency-key': op.key, 'x-edit-time': op.editTime } }); }
      catch { S.offline = true; halted = true; break; }
      S.offline = false;
      if (r.ok || (op.method === 'DELETE' && r.status === 404)) {
        if (r.json && r.json.superseded) { await addNotice({ label: op.label, text: 'Someone else changed this more recently, so their version was kept and this change was not applied.' }); window.dispatchEvent(new CustomEvent('avl:superseded', { detail: op.label })); }
        await remove(op); progressed = true; continue;
      }
      const code = r.json?.error?.code;
      if (r.status === 401) { S.needSignIn = true; halted = true; break; }
      if (code === 'SESSION_CHANGED') { S.needSignIn = true; halted = true; window.dispatchEvent(new CustomEvent('avl:session-changed')); break; }      // someone else signed in on this browser: do NOT send this person's change under their name
      if (code === 'PASSWORD_CHANGE_REQUIRED' || r.status === 429 || r.status >= 500) { op.attempts++; await store.outboxPut(op); halted = true; break; }
      op.status = 'rejected'; op.error = r.json?.error?.message || `The server refused this change (${r.status}).`; op.errorMissing = r.json?.error?.missing || null;
      await store.outboxPut(op); progressed = true;
    }
  }); } finally {
    S.syncing = false;
    if (!halted) { S.lastSync = new Date().toISOString(); await store.metaSet('lastSync:' + S.userId, S.lastSync); }
    emit();
  }
  if (progressed) window.dispatchEvent(new CustomEvent('avl:synced'));
}

// ---------- optimistic view of queued changes, so the screen shows what you just did even before it syncs ----------
const byName = (a, b) => a.name.localeCompare(b.name);
const clone = x => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
function localEquipment(op) {
  const b = op.body, fields = (b.fields || []).map(f => ({ key: f.key, value: f.value || '', provenance: f.provenance, source_url: f.source_url || null, updated_at: op.createdAt })).sort((x, y) => x.key.localeCompare(y.key));
  return { id: b.id, name: b.name, manufacturer: b.manufacturer || null, category: b.category || null, status: 'draft', version: 1, updated_at: op.createdAt, fields,
    verify_keys: fields.filter(f => f.provenance === 'verify').map(f => f.key), approvals: [] };
}
function applyOp(path, data, op) {
  const { method, path: p, body = {} } = op; let m;
  const patchEq = (e) => { if (body.name !== undefined) e.name = body.name; if (body.manufacturer !== undefined) e.manufacturer = body.manufacturer || null; if (body.category !== undefined) e.category = body.category || null; if (e.status === 'approved') e.status = 'needs_review'; };
  if (method === 'POST' && p === '/equipment') {
    const e = localEquipment(op);
    if (path === '/equipment' && data.equipment && !data.equipment.some(x => x.id === e.id)) { data.equipment.push({ id: e.id, name: e.name, manufacturer: e.manufacturer, category: e.category, status: 'draft', version: 1, updated_at: e.updated_at, verify_count: e.verify_keys.length }); data.equipment.sort(byName); }
  } else if (method === 'PATCH' && (m = /^\/equipment\/([\w-]+)$/.exec(p))) {
    if (path === '/equipment' && data.equipment) { const e = data.equipment.find(x => x.id === m[1]); if (e) patchEq(e); }
    if (path === p && data.equipment) {
      const e = data.equipment; patchEq(e);
      for (const f of body.fields || []) { const i = e.fields.findIndex(x => x.key === f.key); const nf = { key: f.key, value: f.value || '', provenance: f.provenance, source_url: f.source_url || null, updated_at: op.createdAt }; if (i >= 0) e.fields[i] = nf; else e.fields.push(nf); }
      if (body.remove_fields) e.fields = e.fields.filter(f => !body.remove_fields.includes(f.key));
      e.fields.sort((x, y) => x.key.localeCompare(y.key)); e.verify_keys = e.fields.filter(f => f.provenance === 'verify').map(f => f.key);
    }
  } else if (method === 'POST' && (m = /^\/equipment\/([\w-]+)\/submit-review$/.exec(p))) {
    if (path === '/equipment' && data.equipment) { const e = data.equipment.find(x => x.id === m[1]); if (e && e.status !== 'approved') e.status = 'needs_review'; }
    if (path === `/equipment/${m[1]}` && data.equipment && data.equipment.status !== 'approved') data.equipment.status = 'needs_review';
  } else if (method === 'PUT' && (m = /^\/equipment\/([\w-]+)\/install-progress$/.exec(p))) {
    if (path === `/equipment/${m[1]}/install-steps` && data.steps) data.done = [...(body.done || [])];
  } else if (method === 'POST' && p === '/issues') {
    if (path === '/issues' && data.issues && !data.issues.some(x => x.id === body.id)) data.issues.unshift({ id: body.id, kind: body.kind, title: body.title, body: body.body || '', equipment_id: body.equipment_id || null, status: 'open', version: 1, created_by: S.userId, updated_by: S.userId, created_at: op.createdAt, updated_at: op.createdAt });
  } else if (method === 'PATCH' && (m = /^\/issues\/([\w-]+)$/.exec(p))) {
    if (path === '/issues' && data.issues) { const i = data.issues.find(x => x.id === m[1]); if (i) Object.assign(i, ['title', 'body', 'status'].reduce((o, k) => (body[k] !== undefined ? { ...o, [k]: body[k] } : o), {})); }
  } else if (method === 'POST' && p === '/updates') {
    if (path === '/updates' && data.updates && !data.updates.some(x => x.id === body.id)) data.updates.unshift({ id: body.id, equipment_id: body.equipment_id, kind: body.kind, available_version: body.available_version, notes: body.notes || '', source_url: body.source_url || null, status: 'available', created_by: S.userId, created_at: op.createdAt });
  } else if (method === 'PATCH' && (m = /^\/updates\/([\w-]+)\/status$/.exec(p))) {
    if (path === '/updates' && data.updates) { const u = data.updates.find(x => x.id === m[1]); if (u) u.status = body.status; }
  } else if (method === 'POST' && (m = /^\/panels\/([\w-]+)\/pins$/.exec(p))) {
    if (path === `/panels/${m[1]}` && data.panel && !data.panel.pins.some(x => x.id === body.id)) { data.panel.pins.push({ id: body.id, x: body.x, y: body.y, label: body.label || '', note: body.note || '', provenance: body.provenance, source_url: body.source_url || null }); if (data.panel.status === 'approved') data.panel.status = 'needs_review'; }
  } else if (method === 'PATCH' && (m = /^\/pins\/([\w-]+)$/.exec(p))) {
    const pin = path.startsWith('/panels/') && data.panel && data.panel.pins.find(x => x.id === m[1]);
    if (pin) { Object.assign(pin, { x: body.x, y: body.y, label: body.label || '', note: body.note || '', provenance: body.provenance, source_url: body.source_url || null }); if (data.panel.status === 'approved') data.panel.status = 'needs_review'; }
  } else if (method === 'DELETE' && (m = /^\/pins\/([\w-]+)$/.exec(p))) {
    if (path.startsWith('/panels/') && data.panel) data.panel.pins = data.panel.pins.filter(x => x.id !== m[1]);
  }
  if (data.panel) data.panel.verify_count = data.panel.pins.filter(x => x.provenance === 'verify').length;
  return data;
}
export function overlay(path, data) {
  const ops = pendingOps(); if (!ops.length || !data || typeof data !== 'object') return data;
  const out = clone(data); for (const op of ops) applyOp(path, out, op); return out;
}
// Reads for a record that only exists locally (created offline, not synced yet).
export function synth(path) {
  const create = id => pendingOps().find(o => o.method === 'POST' && o.path === '/equipment' && o.body && o.body.id === id);
  let m;
  if ((m = /^\/equipment\/([\w-]+)$/.exec(path)) && create(m[1])) return { equipment: localEquipment(create(m[1])) };
  if ((m = /^\/equipment\/([\w-]+)\/install-steps$/.exec(path)) && create(m[1])) return { steps: [], done: [] };
  if ((m = /^\/panels\?equipment_id=([\w-]+)$/.exec(path)) && create(m[1])) return { panels: [] };
  if ((m = /^\/files\?equipment_id=([\w-]+)&purpose=document$/.exec(path)) && create(m[1])) return { files: [] };
  return null;
}
