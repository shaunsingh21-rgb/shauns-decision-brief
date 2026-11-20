import { h, clear, field, select, ROLE, fmtDate } from '../dom.js';
import { get, post, patch, del } from '../api.js';
import { toast, errMsg, state } from '../app.js';

export async function render(root) {
  const [{ users }, { domains }, { entries }] = await Promise.all([get('/users'), get('/sources'), get('/audit?limit=50')]);
  const redraw = () => { clear(root); return render(root); };
  const act = fn => async () => { try { await fn(); await redraw(); } catch (x) { toast(errMsg(x)); } };
  const secret = h('div', { role: 'status' });
  const showTemp = (who, pw) => secret.replaceChildren(h('div', { class: 'notice ok' }, h('strong', {}, `Temporary password for ${who}: `), h('code', {}, pw),
    h('p', { class: 'hint' }, 'Shown once. Give it to them privately. They must choose their own password at first sign-in.')));

  root.append(h('h1', {}, 'Admin'), secret, h('h2', {}, 'People'),
    h('div', { class: 'scroll card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Status', 'Actions'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, users.map(u => { const r = select(Object.entries(ROLE), u.role); r.setAttribute('aria-label', `Role for ${u.username}`);
        r.addEventListener('change', act(() => patch(`/users/${u.id}`, { role: r.value })));
        return h('tr', {}, h('td', {}, u.username), h('td', {}, u.display_name), h('td', {}, r), h('td', {}, u.disabled ? 'Disabled' : (u.must_change_password ? 'Must change password' : 'Active')),
          h('td', {}, h('div', { class: 'row' },
            h('button', { onclick: async () => { try { showTemp(u.username, (await post(`/users/${u.id}/reset-password`)).temporary_password); } catch (x) { toast(errMsg(x)); } } }, 'Reset password'),
            h('button', { onclick: act(() => post(`/users/${u.id}/unlock`)) }, 'Unlock'),
            u.id !== state.user.id && h('button', { class: u.disabled ? '' : 'danger', onclick: act(() => patch(`/users/${u.id}`, { disabled: !u.disabled })) }, u.disabled ? 'Enable' : 'Disable'))));
      })))));
  const un = h('input', { autocapitalize: 'none', maxlength: 64 }), dn = h('input', { maxlength: 80 }), rl = select(Object.entries(ROLE), 'technician');
  root.append(h('details', { class: 'card' }, h('summary', {}, 'Create an account'), field('Username', un), field('Display name', dn), field('Role', rl),
    h('button', { class: 'primary', onclick: async () => { try { const r = await post('/users', { username: un.value, display_name: dn.value, role: rl.value }); await redraw(); showTemp(r.user.username, r.temporary_password); window.scrollTo(0, 0); } catch (x) { toast(errMsg(x)); } } }, 'Create')));

  const dom = h('input', { placeholder: 'e.g. manufacturer.com', maxlength: 253, autocapitalize: 'none' });
  root.append(h('h2', {}, 'Official source domains'), h('p', { class: 'hint' }, 'Web research and “Manufacturer” items are only allowed from these sites (and their subdomains).'),
    h('div', { class: 'card' }, domains.length ? h('ul', {}, domains.map(d => h('li', {}, d.domain, ' ', h('button', { class: 'danger', 'aria-label': `Remove ${d.domain}`, onclick: act(() => del(`/sources/${encodeURIComponent(d.domain)}`)) }, 'Remove')))) : h('p', { class: 'hint' }, 'None yet.'),
      field('Add a domain', dom), h('button', { onclick: act(() => post('/sources', { domain: dom.value })) }, 'Add domain')));

  root.append(h('h2', {}, 'Recent activity (audit log)'), h('div', { class: 'scroll card' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Item'].map(t => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, entries.map(e => h('tr', {}, h('td', {}, fmtDate(e.ts)), h('td', {}, e.actor_name || '—'), h('td', {}, e.action), h('td', {}, e.entity ? `${e.entity} ${String(e.entity_id || '').slice(0, 8)}` : '')))))));
}
