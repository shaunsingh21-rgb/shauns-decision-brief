import { h, clear, fmtDate } from '../dom.js';
import * as sync from '../sync.js';
import { toast } from '../app.js';

export async function render(root) {
  const draw = () => {
    const s = sync.status(), ops = sync.allOps(), notes = sync.notices();
    clear(root).append(h('h1', {}, 'Sync'),
      h('div', { class: `notice ${sync.statusLevel(s) === 'ok' ? 'ok' : sync.statusLevel(s) === 'bad' ? 'bad' : ''}`, role: 'status' }, sync.statusText(s), s.lastSync ? ` · last synced ${fmtDate(s.lastSync)}` : ''),
      h('p', { class: 'hint' }, 'When you’re offline, your changes are saved on this device and sent in order when the connection is back. Sign-offs, approvals and quiz results are never merged or overwritten: the server records each one under your name.'),
      h('p', {}, h('button', { class: 'primary', disabled: !ops.some(o => o.status === 'pending') || s.syncing, onclick: async () => { await sync.flush(); draw(); } }, 'Sync now')),
      notes.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Heads up'), h('ul', {}, notes.map(n => h('li', {}, h('strong', {}, n.label), ': ', n.text, ` (${fmtDate(n.at)})`))),
        h('button', { onclick: async () => { await sync.dismissNotices(); draw(); } }, 'Dismiss')),
      h('h2', {}, 'Waiting changes'), ops.length ? ops.map(o => h('div', { class: 'card' }, h('strong', {}, o.label), h('div', { class: 'hint' }, `Made ${fmtDate(o.createdAt)}`),
        o.status === 'pending' ? h('span', { class: 'badge b-needs_review' }, 'Waiting to sync') : h('div', { class: 'notice bad', role: 'alert' }, o.error || 'The server did not accept this change.',
          o.errorMissing ? h('ul', {}, o.errorMissing.map(t => h('li', {}, t))) : null),
        h('div', { class: 'row' }, o.status === 'rejected' && h('button', { onclick: async () => { await sync.retry(o.seq); draw(); } }, 'Try again'),
          h('button', { class: 'danger', onclick: async () => { if (confirm('Discard this change? It will not be saved.')) { await sync.discard(o.seq); toast('Discarded.'); draw(); } } }, 'Discard')))) : h('p', { class: 'hint' }, 'Nothing is waiting.'));
  };
  draw(); const un = sync.subscribe(() => { if (location.hash === '#/sync') draw(); }); window.addEventListener('hashchange', function once() { un(); window.removeEventListener('hashchange', once); });
}
