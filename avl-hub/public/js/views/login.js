import { h, field } from '../dom.js';
import { post, get } from '../api.js';
import { errMsg } from '../app.js';

export function renderLogin(root, onAuth, notice) {
  const err = h('div', { role: 'alert' }, notice ? h('div', { class: 'notice' }, notice) : null);
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card', onsubmit: async e => {
    e.preventDefault(); err.replaceChildren();
    try {
      const r = await post('/auth/login', { username: user.value.trim(), password: pass.value });
      if (r.mfa_required) return codeStep(root, r.challenge, onAuth);          // password was right; now the second step
      onAuth(r.user);
    } catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); pass.value = ''; }
  } }, field('Username', user), field('Password', pass), err,
    h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Sign in')),
    h('p', { class: 'hint' }, 'Accounts are created by your team administrator. Forgot your password? Ask an administrator to reset it.'));
  root.replaceChildren(h('div', { class: 'login' }, h('h1', {}, 'AVL Tech Hub'), h('p', { class: 'hint' }, 'ITS Events — Training & Equipment'), form));
  user.focus();
}

// Second step: a 6-digit code from the authenticator app, or a one-time recovery code.
function codeStep(root, challenge, onAuth) {
  let recovery = false; const err = h('div', { role: 'alert' });
  const input = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 24 });
  const lbl = h('label', {}, 'Authentication code'); const hint = h('div', { class: 'hint' }, 'Open your authenticator app and type the 6-digit code for AVL Tech Hub.');
  const toggle = h('button', { type: 'button', onclick: () => {
    recovery = !recovery; lbl.textContent = recovery ? 'Recovery code' : 'Authentication code'; input.value = '';
    input.setAttribute('inputmode', recovery ? 'text' : 'numeric'); input.setAttribute('autocomplete', recovery ? 'off' : 'one-time-code');
    hint.textContent = recovery ? 'Type one of the recovery codes you saved when you set this up, like abcde-fghjk. Each works once.' : 'Open your authenticator app and type the 6-digit code for AVL Tech Hub.';
    toggle.textContent = recovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'; input.focus(); } }, 'Use a recovery code instead');
  input.id = 'mfa-code'; lbl.setAttribute('for', 'mfa-code');
  const form = h('form', { class: 'card', onsubmit: async e => {
    e.preventDefault(); err.replaceChildren();
    try { onAuth((await post('/auth/mfa/verify', { challenge, code: input.value })).user); }
    catch (x) {
      if (x.code === 'CHALLENGE_EXPIRED' || x.code === 'ACCOUNT_LOCKED') return renderLogin(root, onAuth, errMsg(x));
      err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); input.value = ''; input.focus();
    }
  } }, lbl, input, hint, err, h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Sign in'), toggle, h('button', { type: 'button', onclick: () => renderLogin(root, onAuth) }, 'Back')));
  root.replaceChildren(h('div', { class: 'login' }, h('h1', {}, 'Two-step sign-in'), form)); input.focus();
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
      try { await post('/auth/change-password', { current_password: cur.value, new_password: n1.value }); location.hash = '#/equipment'; onAuth((await get('/me')).user); }
      catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); }
    } }, field('Current (temporary) password', cur), field('New password', n1, 'At least 12 characters. Must not contain your username.'),
      field('Repeat new password', n2), err, h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Save password')))));
}
