import { h, clear, field } from '../dom.js';
import { get, post } from '../api.js';
import { state, toast, errMsg } from '../app.js';

export async function render(root) {
  const mfa = await get('/auth/mfa');
  root.append(h('h1', {}, 'My account'), profile(), passwordCard(), h('h2', {}, 'Two-step sign-in'), mfaCard(mfa, () => { clear(root); render(root); }));
}

// Shown instead of the app when the person's role requires two-step sign-in and they have not set it up yet.
export async function renderForcedEnrol(root, onDone, signOut) {
  const mfa = await get('/auth/mfa');
  // replaceChildren (not append): if two navigations overlap, the page still ends up with exactly one copy of this screen.
  root.replaceChildren(h('div', { class: 'login' }, h('h1', {}, 'Set up two-step sign-in'),
    h('div', { class: 'notice' }, 'Your role requires two-step sign-in. Set it up now to continue. It takes about a minute.'),
    mfaCard(mfa, async () => onDone((await get('/me')).user)), h('p', {}, h('button', { onclick: signOut }, 'Sign out'))));
}

function profile() {
  const u = state.user;
  return h('div', { class: 'card' }, h('h2', {}, u.display_name), h('p', { class: 'hint' }, `Username ${u.username} · ${u.role_name}`),
    u.permissions.length ? h('details', {}, h('summary', {}, 'What my role can do'), h('p', { class: 'hint' }, 'Everyone can read equipment, training and issues. Your role can also: '), h('ul', {}, u.permissions.map(p => h('li', {}, p)))) : h('p', { class: 'hint' }, 'Your role is read-only.'));
}

function passwordCard() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12 }), n2 = h('input', { type: 'password', autocomplete: 'new-password' }), err = h('div', { role: 'alert' });
  return h('form', { class: 'card', onsubmit: async e => {
    e.preventDefault(); err.replaceChildren(); if (n1.value !== n2.value) return err.replaceChildren(h('div', { class: 'notice bad' }, 'The new passwords do not match.'));
    try { await post('/auth/change-password', { current_password: cur.value, new_password: n1.value }); cur.value = n1.value = n2.value = ''; toast('Password changed. Your other devices were signed out.'); }
    catch (x) { err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x))); }
  } }, h('h2', {}, 'Change my password'), field('Current password', cur), field('New password', n1, 'At least 12 characters. Must not contain your username.'), field('Repeat new password', n2), err, h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Change password')));
}

function mfaCard(mfa, refresh) {
  const card = h('div', { class: 'card' });
  const say = (...kids) => clear(card).append(...kids);
  if (!mfa.available) return say(h('p', {}, 'Two-step sign-in is not available on this server.'), h('p', { class: 'hint' }, 'Your administrator can turn it on (see the deployment guide).')), card;
  const err = h('div', { role: 'alert' }); const showErr = x => err.replaceChildren(h('div', { class: 'notice bad' }, errMsg(x)));

  const off = () => say(h('p', {}, h('span', { class: 'badge b-draft' }, 'Off'), ' Two-step sign-in adds a code from an app on your phone when you sign in. It is optional.'),
    h('p', {}, h('button', { class: 'primary', onclick: askPassword }, 'Turn on two-step sign-in')));

  function askPassword() {
    const pw = h('input', { type: 'password', autocomplete: 'current-password' });
    say(h('form', { onsubmit: async e => { e.preventDefault(); err.replaceChildren(); try { scan(await post('/auth/mfa/setup', { password: pw.value })); } catch (x) { showErr(x); } } },
      h('h3', {}, 'Step 1 of 3: confirm it is you'), field('Your password', pw), err, h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Continue'), h('button', { type: 'button', onclick: off }, 'Cancel'))));
  }
  function scan(s) {
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8 });
    say(h('form', { onsubmit: async e => { e.preventDefault(); err.replaceChildren(); try { saved((await post('/auth/mfa/enable', { code: code.value })).recovery_codes); } catch (x) { showErr(x); } } },
      h('h3', {}, 'Step 2 of 3: add it to your authenticator app'),
      h('p', {}, 'Open an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…), add an account, and scan this picture.'),
      h('img', { src: s.qr, alt: 'QR code to scan with your authenticator app', width: 240, height: 240, class: 'qr' }),
      h('details', {}, h('summary', {}, 'Can’t scan? Type the key instead'), h('p', {}, h('code', { class: 'key' }, s.secret)), h('p', { class: 'hint' }, 'Account name: your username. Type of key: time-based.')),
      field('Step 3 of 3: type the 6-digit code the app now shows', code), err, h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Turn on'), h('button', { type: 'button', onclick: off }, 'Cancel'))));
  }
  function saved(codes) {
    const text = `AVL Tech Hub recovery codes for ${state.user.username}\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`;
    const ok = h('input', { type: 'checkbox', id: 'saved-codes' }), done = h('button', { class: 'primary', disabled: true, onclick: refresh }, 'Done');
    ok.addEventListener('change', () => { done.disabled = !ok.checked; });
    say(h('h3', {}, 'Two-step sign-in is on'), h('div', { class: 'notice' }, h('strong', {}, 'Save these recovery codes now. '), 'They are shown only once. If you lose your phone, each code lets you sign in one time.'),
      h('ul', { class: 'codes' }, codes.map(c => h('li', {}, h('code', {}, c)))),
      h('div', { class: 'row' }, h('button', { onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Could not copy. Select the codes and copy them by hand.'); } } }, 'Copy codes'),
        h('button', { onclick: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'avl-hub-recovery-codes.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); } }, 'Download as a file')),
      h('div', { class: 'opt' }, ok, h('label', { for: 'saved-codes', class: 'plain' }, 'I have saved these codes')), done);
  }
  const on = () => say(h('p', {}, h('span', { class: 'badge b-approved' }, 'On'), ' You are asked for a code from your authenticator app each time you sign in.'),
    h('p', { class: mfa.recovery_codes_left <= 2 ? 'notice' : 'hint' }, `Recovery codes left: ${mfa.recovery_codes_left}.${mfa.recovery_codes_left <= 2 ? ' Replace them soon.' : ''}`),
    mfa.required_by_role && h('p', { class: 'hint' }, 'Your role requires two-step sign-in, so it cannot be turned off.'),
    h('div', { class: 'row' }, h('button', { onclick: () => confirmWith('Replace my recovery codes', 'recovery-codes', 'Replace codes', r => saved(r.recovery_codes)) }, 'Replace recovery codes'),
      !mfa.required_by_role && h('button', { class: 'danger', onclick: () => confirmWith('Turn off two-step sign-in', 'disable', 'Turn off', () => { toast('Two-step sign-in is off.'); refresh(); }) }, 'Turn off')));
  function confirmWith(title, action, label, then) {
    const pw = h('input', { type: 'password', autocomplete: 'current-password' }), code = h('input', { type: 'text', autocomplete: 'one-time-code', maxlength: 24 });
    say(h('form', { onsubmit: async e => { e.preventDefault(); err.replaceChildren(); try { then(await post(`/auth/mfa/${action}`, { password: pw.value, code: code.value })); } catch (x) { showErr(x); } } },
      h('h3', {}, title), field('Your password', pw), field('A current code from your app (or a recovery code)', code), err, h('div', { class: 'row' }, h('button', { class: action === 'disable' ? 'danger' : 'primary', type: 'submit' }, label), h('button', { type: 'button', onclick: on }, 'Cancel'))));
  }
  mfa.enabled ? on() : off();
  return card;
}
