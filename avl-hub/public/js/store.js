// Local storage on this device: cached reads, the outbox of changes waiting to sync, and small bits of metadata.
// IndexedDB when available; plain memory if the browser blocks it (private windows), so the app still works online.
const mem = { cache: new Map(), outbox: [], meta: new Map(), seq: 0 };
let dbp;
const db = () => dbp ||= new Promise((resolve, reject) => {
  try {
    const r = indexedDB.open('avl-hub', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('cache', { keyPath: 'key' }); d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); d.createObjectStore('meta', { keyPath: 'k' }); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); r.onblocked = () => reject(new Error('blocked'));
  } catch (e) { reject(e); }
}).catch(() => null);

const run = (store, mode, fn) => db().then(d => new Promise((resolve, reject) => {
  const tx = d.transaction(store, mode); let out; const req = fn(tx.objectStore(store)); if (req) req.onsuccess = () => { out = req.result; };
  tx.oncomplete = () => resolve(out); tx.onerror = tx.onabort = () => reject(tx.error);
}));

export const cacheGet = async key => { const d = await db(); return d ? run('cache', 'readonly', s => s.get(key)) : mem.cache.get(key); };
export const cachePut = async (key, data) => { const rec = { key, data, at: Date.now() }; const d = await db(); return d ? run('cache', 'readwrite', s => s.put(rec)) : void mem.cache.set(key, rec); };
export const outboxList = async () => { const d = await db(); const all = d ? await run('outbox', 'readonly', s => s.getAll()) : [...mem.outbox]; return all.sort((a, b) => a.seq - b.seq); };
export const outboxAdd = async op => { const d = await db(); if (d) return run('outbox', 'readwrite', s => s.add(op)); op.seq = ++mem.seq; mem.outbox.push(op); return op.seq; };
export const outboxPut = async op => { const d = await db(); if (d) return run('outbox', 'readwrite', s => s.put(op)); const i = mem.outbox.findIndex(o => o.seq === op.seq); if (i >= 0) mem.outbox[i] = op; };
export const outboxGet = async seq => { const d = await db(); return d ? run('outbox', 'readonly', s => s.get(seq)) : mem.outbox.find(o => o.seq === seq); };
export const outboxDelete = async seq => { const d = await db(); if (d) return run('outbox', 'readwrite', s => s.delete(seq)); mem.outbox = mem.outbox.filter(o => o.seq !== seq); };
export const metaGet = async k => { const d = await db(); const r = d ? await run('meta', 'readonly', s => s.get(k)) : mem.meta.get(k); return r ? r.v : undefined; };
export const metaSet = async (k, v) => { const d = await db(); return d ? run('meta', 'readwrite', s => s.put({ k, v })) : void mem.meta.set(k, { k, v }); };
// Sign-out on a shared device: remove everything THIS person left behind. Another person's unsynced work on the same browser is never touched.
export async function clearUser(uid) {
  for (const k of [...mem.cache.keys()]) if (k.startsWith(uid + '|')) mem.cache.delete(k);
  mem.outbox = mem.outbox.filter(o => o.userId !== uid); for (const k of [`notices:${uid}`, `lastSync:${uid}`]) mem.meta.delete(k);
  const u = mem.meta.get('user'); if (u && u.v && u.v.id === uid) mem.meta.delete('user');
  const d = await db(); if (!d) return;
  const keys = await run('cache', 'readonly', s => s.getAllKeys()); for (const k of keys) if (String(k).startsWith(uid + '|')) await run('cache', 'readwrite', s => s.delete(k));
  const ops = await run('outbox', 'readonly', s => s.getAll()); for (const o of ops) if (o.userId === uid) await run('outbox', 'readwrite', s => s.delete(o.seq));
  for (const k of [`notices:${uid}`, `lastSync:${uid}`]) await run('meta', 'readwrite', s => s.delete(k));
  const cur = await run('meta', 'readonly', s => s.get('user')); if (cur && cur.v && cur.v.id === uid) await run('meta', 'readwrite', s => s.delete('user'));
}
// Wipe everything (kept for completeness; sign-out uses clearUser).
export async function clearAll() {
  mem.cache.clear(); mem.outbox = []; mem.meta.clear();
  const d = await db(); if (!d) return;
  for (const s of ['cache', 'outbox', 'meta']) await run(s, 'readwrite', st => st.clear());
}
