export class ApiError extends Error {
  constructor(status, err) { super(err?.message || 'Request failed'); this.status = status; this.code = err?.code; this.data = err || {}; }
}
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, { method, credentials: 'same-origin',
      headers: { 'x-requested-by': 'avl-hub', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, { code: 'OFFLINE', message: 'You appear to be offline.' }); }
  let json = null; try { json = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('avl:signed-out'));
    if (json?.error?.code === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new CustomEvent('avl:password-change'));
    throw new ApiError(res.status, json?.error);
  }
  return json;
}
export const get = p => api('GET', p), post = (p, b = {}) => api('POST', p, b), patch = (p, b = {}) => api('PATCH', p, b),
  put = (p, b = {}) => api('PUT', p, b), del = p => api('DELETE', p);

// Multipart upload. Fields go BEFORE the file so the server can read them first.
export async function upload(file, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  fd.append('file', file, file.name || 'upload');
  let res;
  try { res = await fetch('/api/files', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-requested-by': 'avl-hub' } }); }
  catch { throw new ApiError(0, { code: 'OFFLINE', message: 'You appear to be offline.' }); }
  let json = null; try { json = await res.json(); } catch {}
  if (!res.ok) { if (res.status === 401) window.dispatchEvent(new CustomEvent('avl:signed-out')); throw new ApiError(res.status, json?.error); }
  return json.file;
}
