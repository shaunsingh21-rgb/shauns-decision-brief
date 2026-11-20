import { h, field } from '../dom.js';
import { post } from '../api.js';
import { errMsg } from '../app.js';

export function renderLogin(root, onAuth) {
  const err = h('div', { role: 'alert' });
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card', onsubmit: async e => {
    e.preventDefault(); err.replaceChildren();
    try { onAuth((await post('/auth/login', { username: user.value.trim(), password: pass.value })).user); }
    catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); pass.value = ''; }
  } }, field('Username', user), field('Password', pass), err,
    h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Sign in')),
    h('p', { class: 'hint' }, 'Accounts are created by your team administrator. Forgot your password? Ask an administrator to reset it.'));
  root.append(h('div', { class: 'login' }, h('h1', {}, 'AVL Tech Hub'), h('p', { class: 'hint' }, 'ITS Events — Training & Equipment'), form));
  user.focus();
}

export function renderChange(root, onAuth) {
  const err = h('div', { role: 'alert' });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  root.append(h('div', { class: 'login' }, h('h1', {}, 'Choose a new password'),
    h('div', { class: 'notice' }, 'For security, you must set your own password before continuing.'),
    h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault(); err.replaceChildren();
      if (n1.value !== n2.value) return err.replaceChildren(h('div', { class: 'notice bad' }, 'The new passwords do not match.'));
      try { await post('/auth/change-password', { current_password: cur.value, new_password: n1.value }); location.hash = '#/equipment'; onAuth({ ...(await (await import('../api.js')).get('/me')).user }); }
      catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); }
    } }, field('Current (temporary) password', cur), field('New password', n1, 'At least 12 characters. Must not contain your username.'),
      field('Repeat new password', n2), err, h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Save password')))));
}
