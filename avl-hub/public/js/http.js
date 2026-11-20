export class ApiError extends Error {
  constructor(status, err) { super(err?.message || 'Request failed'); this.status = status; this.code = err?.code; this.data = err || {}; }
}
// Our clock vs the server's. Edit times are stamped with the corrected clock so a phone with a wrong clock still orders edits fairly.
let offset = 0;
export const serverNow = () => Date.now() + offset;

// Low-level request. Resolves with {ok,status,json} for ANY http status; throws ApiError(OFFLINE) only when the network failed.
export async function request(method, url, body, { headers = {}, timeout = 20000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, credentials: 'same-origin', signal: AbortSignal.timeout(timeout),
      headers: { 'x-requested-by': 'avl-hub', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, { code: 'OFFLINE', message: 'You appear to be offline.' }); }
  const d = Date.parse(res.headers.get('date') || ''); if (!Number.isNaN(d)) offset = d - Date.now();
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, json };
}
