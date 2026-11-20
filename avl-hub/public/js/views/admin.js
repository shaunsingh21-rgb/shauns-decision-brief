import { h, clear, field, select, fmtDate } from '../dom.js';
import { get, post, patch, del } from '../api.js';
import { toast, errMsg, state, can } from '../app.js';

// A temporary password must survive the redraw that follows creating an account, or the admin would never see it.
let carry = null;
const tempNotice = (who, pw) => h('div', { class: 'notice ok' }, h('strong', {}, `Temporary password for ${who}: `), h('code', {}, pw),
  h('p', { class: 'hint' }, 'Shown once. Give it to them privately. They must choose their own password at first sign-in.'));

// Each section appears only if the signed-in person's role allows it. The server re-checks every action regardless.
export async function render(root) {
  const redraw = () => { clear(root); return render(root); };
  const act = fn => async () => { try { await fn(); await redraw(); } catch (x) { toast(errMsg(x)); } };
  const [usersRes, rolesRes, domainsRes, auditRes] = await Promise.all([
    can('users.manage') ? get('/users') : null, can('roles.manage', 'users.manage') ? get('/roles') : null,
    can('sources.manage') ? get('/sources') : null, can('audit.view') ? get('/audit?limit=50') : null]);
  const secret = h('div', { role: 'status' });
  if (carry) { secret.append(tempNotice(carry.who, carry.pw)); carry = null; }
  root.append(h('h1', {}, 'Admin'), secret);
  if (usersRes) root.append(...peopleSection(usersRes.users, rolesRes.roles, secret, redraw, act));
  if (can('roles.manage') && rolesRes) root.append(...rolesSection(rolesRes, redraw));
  if (domainsRes) root.append(...sourcesSection(domainsRes.domains, act));
  if (can('data.manage')) root.append(...dataSection());
  if (auditRes) root.append(...auditSection(auditRes.entries));
  if (root.children.length <= 2) root.append(h('p', { class: 'hint' }, 'Your role has no administration permissions.'));
}

// ---------------------------------------------------------------- people
function peopleSection(users, roles, secret, redraw, act) {
  const showTemp = (who, pw) => secret.replaceChildren(tempNotice(who, pw));
  const assignable = roles.filter(r => r.can_assign);
  const rows = users.map(u => {
    const r = select([...assignable.map(x => [x.id, x.name]), ...(assignable.some(x => x.id === u.role) ? [] : [[u.role, u.role_name]])], u.role);
    r.setAttribute('aria-label', `Role for ${u.username}`); r.disabled = !u.can_manage;
    r.addEventListener('change', act(() => patch(`/users/${u.id}`, { role: r.value })));
    return h('tr', {}, h('td', {}, u.username), h('td', {}, u.display_name), h('td', {}, r),
      h('td', {}, [u.disabled ? 'Disabled' : (u.must_change_password ? 'Must change password' : 'Active'), u.mfa_enabled ? ' · two-step on' : ''].join('')),
      h('td', {}, u.can_manage ? h('div', { class: 'row' },
        h('button', { onclick: async () => { try { showTemp(u.username, (await post(`/users/${u.id}/reset-password`)).temporary_password); } catch (x) { toast(errMsg(x)); } } }, 'Reset password'),
        h('button', { onclick: act(() => post(`/users/${u.id}/unlock`)) }, 'Unlock'),
        u.mfa_enabled && h('button', { 'aria-label': `Reset two-step sign-in for ${u.username}`, onclick: async () => { if (confirm(`Turn off two-step sign-in for ${u.username}? Do this only if they lost their phone and recovery codes. They can set it up again.`)) { try { await post(`/users/${u.id}/mfa-reset`); toast('Two-step sign-in reset.'); await redraw(); } catch (x) { toast(errMsg(x)); } } } }, 'Reset two-step'),
        u.id !== state.user.id && h('button', { class: u.disabled ? '' : 'danger', onclick: act(() => patch(`/users/${u.id}`, { disabled: !u.disabled })) }, u.disabled ? 'Enable' : 'Disable'))
        : h('span', { class: 'hint' }, 'Their role has more power than yours')));
  });
  const un = h('input', { autocapitalize: 'none', maxlength: 64 }), dn = h('input', { maxlength: 80 });
  const rl = select(assignable.map(x => [x.id, x.name]), (assignable.find(x => x.id === 'technician') || assignable[0] || {}).id);
  return [h('h2', {}, 'People'),
    h('div', { class: 'scroll card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Status', 'Actions'].map(t => h('th', { scope: 'col' }, t)))), h('tbody', {}, rows))),
    h('details', { class: 'card' }, h('summary', {}, 'Create an account'), field('Username', un), field('Display name', dn), field('Role', rl, 'You can only choose roles with no more power than your own.'),
      h('button', { class: 'primary', onclick: async () => { try { const r = await post('/users', { username: un.value, display_name: dn.value, role: rl.value }); carry = { who: r.user.username, pw: r.temporary_password }; await redraw(); window.scrollTo(0, 0); } catch (x) { toast(errMsg(x)); } } }, 'Create'))];
}

// ---------------------------------------------------------------- roles & permissions
function rolesSection({ roles, catalogue }, redraw) {
  const out = h('div'); const mine = new Set(state.user.permissions);
  const label = k => (catalogue.find(c => c.key === k) || {}).label || k;
  const show = () => {
    clear(out).append(...roles.map(r => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('strong', {}, r.name), h('span', { class: 'badge b-draft' }, r.locked ? 'Built-in · locked' : r.is_system ? 'Built-in' : 'Custom'), r.require_mfa && h('span', { class: 'badge b-needs_review' }, 'Requires two-step'),
        h('span', { class: 'hint' }, `${r.user_count} ${r.user_count === 1 ? 'person' : 'people'}`)),
      r.description && h('p', { class: 'hint' }, r.description),
      r.permissions.length ? h('ul', { class: 'permlist' }, r.permissions.map(k => h('li', {}, label(k)))) : h('p', { class: 'hint' }, 'No permissions: can read everything but change nothing.'),
      !r.can_edit && !r.locked && h('p', { class: 'hint' }, 'This role has more power than yours, so you cannot change it.'),
      h('div', { class: 'row' },
        (r.can_edit || r.locked) && h('button', { onclick: () => form(r) }, r.locked ? 'Two-step setting' : 'Edit'),
        r.can_edit && r.is_system && !r.locked && h('button', { onclick: async () => { if (confirm(`Put “${r.name}” back to its original permissions?`)) { try { await post(`/roles/${r.id}/reset`); toast('Reset.'); await redraw(); } catch (x) { toast(errMsg(x)); } } } }, 'Reset to defaults'),
        r.can_edit && !r.is_system && h('button', { class: 'danger', 'aria-label': `Delete role ${r.name}`, onclick: async () => { if (confirm(`Delete the role “${r.name}”?`)) { try { await del(`/roles/${r.id}`); toast('Deleted.'); await redraw(); } catch (x) { toast(errMsg(x)); } } } }, 'Delete')))));
  };
  function form(role) {
    const editing = !!role, locked = role && role.locked;
    const name = h('input', { value: role ? role.name : '', maxlength: 40, disabled: !!(role && role.is_system) });
    const desc = h('textarea', { maxlength: 300, disabled: !!locked }, role ? role.description : '');
    const chosen = new Set(role ? role.permissions : []);
    const mfaOn = !!(state.user.features && state.user.features.mfa);
    const mfa = h('input', { type: 'checkbox', checked: !!(role && role.require_mfa), disabled: !mfaOn });
    const groups = [...new Set(catalogue.map(c => c.group))];
    const boxes = groups.map(g => h('fieldset', {}, h('legend', {}, g), ...catalogue.filter(c => c.group === g).map(c => {
      const cannot = !mine.has(c.key) && !locked;
      const cb = h('input', { type: 'checkbox', checked: chosen.has(c.key), disabled: cannot || !!locked, 'aria-describedby': `ph-${c.key}`, onchange: e => { e.target.checked ? chosen.add(c.key) : chosen.delete(c.key); } });
      return h('div', { class: 'perm' }, h('label', { class: 'opt plain' }, cb, h('span', {}, c.label)),
        h('div', { class: 'hint', id: `ph-${c.key}` }, [c.help, cannot ? 'You don’t have this permission yourself, so you can’t give it.' : ''].filter(Boolean).join(' ')));
    })));
    const err = h('div', { role: 'alert' });
    clear(out).append(h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault(); err.replaceChildren();
      try {
        if (editing) await patch(`/roles/${role.id}`, locked ? { require_mfa: mfa.checked } : { ...(role.is_system ? {} : { name: name.value }), description: desc.value, permissions: [...chosen], require_mfa: mfa.checked });
        else await post('/roles', { name: name.value, description: desc.value, permissions: [...chosen], require_mfa: mfa.checked });
        toast('Saved.'); await redraw();
      } catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x), x.data && x.data.not_permitted ? ` (${x.data.not_permitted.map(label).join(', ')})` : '')); }
    } }, h('h3', {}, editing ? `Edit role: ${role.name}` : 'New role'),
      locked && h('div', { class: 'notice' }, 'Leader/Admin always has every permission and cannot be changed. You can only choose whether it must use two-step sign-in.'),
      field('Name', name), field('What is this role for? (optional)', desc), h('h4', {}, 'Permissions'),
      h('p', { class: 'hint' }, 'Everyone signed in can read equipment, training and issues. These are the things a role can additionally do.'), ...boxes,
      h('label', { class: 'opt plain' }, mfa, h('span', {}, 'Require two-step sign-in for people in this role')),
      !mfaOn && h('div', { class: 'hint' }, 'Two-step sign-in is not set up on this server (see the deployment guide: MFA_ENCRYPTION_KEY).'), err,
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save role'), h('button', { type: 'button', onclick: show }, 'Cancel'))));
  }
  show();
  return [h('h2', {}, 'Roles and permissions'), h('p', { class: 'hint' }, 'A role is a named set of permissions. Create your own, or adjust the built-in ones. Changes apply immediately. You can only give permissions you have yourself.'),
    h('p', {}, h('button', { class: 'primary', onclick: () => form(null) }, 'New role')), out];
}

// ---------------------------------------------------------------- official sources
function sourcesSection(domains, act) {
  const dom = h('input', { placeholder: 'e.g. manufacturer.com', maxlength: 253, autocapitalize: 'none' });
  return [h('h2', {}, 'Official source domains'), h('p', { class: 'hint' }, 'Web research and “Manufacturer” items are only allowed from these sites (and their subdomains).'),
    h('div', { class: 'card' }, domains.length ? h('ul', {}, domains.map(d => h('li', {}, d.domain, ' ', h('button', { class: 'danger', 'aria-label': `Remove ${d.domain}`, onclick: act(() => del(`/sources/${encodeURIComponent(d.domain)}`)) }, 'Remove')))) : h('p', { class: 'hint' }, 'None yet.'),
      field('Add a domain', dom), h('button', { onclick: act(() => post('/sources', { domain: dom.value })) }, 'Add domain'))];
}

// ---------------------------------------------------------------- export / import (content only; never accounts, approvals or sign-offs)
function dataSection() {
  const report = h('div', { role: 'status' }); const file = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Choose an export file' });
  let parsed = null;
  const showReport = r => report.replaceChildren(h('div', { class: `notice ${r.dry_run ? '' : 'ok'}` }, h('strong', {}, r.dry_run ? 'Check only — nothing has been changed. ' : 'Imported. '),
    `Added: ${Object.entries(r.added).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') || 'nothing'}. Already present (skipped): ${Object.entries(r.skipped).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') || 'nothing'}.`,
    r.warnings.length ? h('ul', {}, r.warnings.map(w => h('li', {}, w))) : null, h('p', { class: 'hint' }, r.note)),
    r.dry_run && h('p', {}, h('button', { class: 'primary', onclick: async () => { try { showReport(await post('/admin/import', { data: parsed, dry_run: false })); } catch (x) { report.replaceChildren(h('div', { class: 'notice bad', role: 'alert' }, errMsg(x))); } } }, 'Import now')));
  return [h('h2', {}, 'Export and import content'),
    h('div', { class: 'card' }, h('p', { class: 'hint' }, 'Content only: equipment, training material, issues, update records and the source list. Never accounts, passwords, approvals, sign-offs or photos. Import only adds what is missing, as Draft. This is not a backup; see the backup guide.'),
      h('div', { class: 'row' }, h('button', { onclick: async () => {
        try { const data = await get('/admin/export'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = `avl-hub-content-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
        catch (x) { toast(errMsg(x)); } } }, 'Download export')),
      field('Import a file', file), h('button', { onclick: async () => {
        const f = file.files[0]; if (!f) return toast('Choose a file first.'); if (f.size > 5.5e6) return toast('That file is too large (5 MB maximum).');
        try { parsed = JSON.parse(await f.text()); } catch { return report.replaceChildren(h('div', { class: 'notice bad', role: 'alert' }, 'That file is not valid JSON.')); }
        try { showReport(await post('/admin/import', { data: parsed, dry_run: true })); } catch (x) { report.replaceChildren(h('div', { class: 'notice bad', role: 'alert' }, errMsg(x), x.data && x.data.details ? h('ul', {}, x.data.details.slice(0, 8).map(d => h('li', {}, `${d.path}: ${d.message}`))) : null)); } } }, 'Check the file'), report)];
}

// ---------------------------------------------------------------- audit
function auditSection(entries) {
  return [h('h2', {}, 'Recent activity (audit log)'), h('div', { class: 'scroll card' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Item'].map(t => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, entries.map(e => h('tr', {}, h('td', {}, fmtDate(e.ts)), h('td', {}, e.actor_name || '—'), h('td', {}, e.action), h('td', {}, e.entity ? `${e.entity} ${String(e.entity_id || '').slice(0, 8)}` : ''))))))];
}
