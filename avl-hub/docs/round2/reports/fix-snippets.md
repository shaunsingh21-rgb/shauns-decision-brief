# Ready-to-use fixes (not applied; repo is read-only for this review)

## 1. Sync chip (app.js, function syncLine) - fixes axe link-name + aria-allowed-role on every signed-in screen
```js
function syncLine() {
  const link = h('a', { href: '#/sync', class: 'syncline' });
  const live = h('span', { class: 'vh', role: 'status', 'aria-live': 'polite' });   // announces; the link keeps its link role and name
  unsubStatus?.(); unsubStatus = sync.subscribe(s => { const t = sync.statusText(s); link.textContent = t; live.textContent = t; link.className = `syncline s-${sync.statusLevel(s)}`; });
  return h('span', {}, link, live);
}
```
(Make the live region a stable element in index.html if announcements on first paint are unwanted.)

## 2. Form-control borders (app.css) - WCAG 1.4.11 (needs 3:1)
```css
:root{--line-ctl:#76857f}                                   /* 3.87:1 on #fff, 3.5:1 on #f5f7f4 */
@media (prefers-color-scheme:dark){:root{--line-ctl:#6f8a80}} /* 4.3:1 on #17231f */
:root[data-theme=dark]{--line-ctl:#6f8a80}
input,select,textarea,button:not(.primary):not(.danger):not(.linkish),.btn:not(.primary){border-color:var(--line-ctl)}
```

## 3. Pin accessible name (panels.js pinBtn) - WCAG 2.5.3 (name must contain the visible text)
Visible text is "1" plus a source letter. Make the letter CSS-generated so the DOM text is just the number, and start the name with that number:
```js
h('button', { class: `pin b-${p.provenance}`, 'data-src': letter, 'aria-label': `${n}. ${p.label || 'Not identified'}, source ${PROV[p.provenance]}` }, String(n))
```
```css
.pin::after{content:attr(data-src);position:absolute;right:-8px;bottom:-8px;/* same styles as .src */}
```

## 4. Hints and errors tied to fields (dom.js field helper) - WCAG 1.3.1 / 3.3.1 / 3.3.2
```js
export function field(label, input, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 9); input.id = id;
  const hid = hint ? id + '-h' : null; if (hid) input.setAttribute('aria-describedby', hid);
  return h('div', {}, h('label', { for: id }, label), input, hint && h('div', { class: 'hint', id: hid }, hint));
}
// when a server error has x.data.details, mark the offending input: input.setAttribute('aria-invalid','true'); input.focus();
// and make errMsg(e) append details: e.data?.details?.map(d => d.message).join('; ')
```

## 5. Focus that survives re-render (app.js / dom.js)
busyGuard disables the clicked button, which drops focus to <body>. Use aria-disabled + a click guard instead of `disabled`, and after clear(root)+render restore focus:
```js
// before re-render: const key = document.activeElement?.dataset?.focusKey || document.activeElement?.textContent;
// after render:     (find button/link with same text, or main) .focus({preventScroll:true})
```
Simplest rule set: after Edit -> focus first field; after Cancel/Save -> focus the Edit button; after Escape in place mode -> focus "Add a pin"; after Quiz me -> focus the question heading (tabindex -1); after a failed sign-in -> focus the username (or the alert).

## 6. Role select in People table (admin.js line ~35)
Do not PATCH on `change`. Add a "Save role" button that appears when the value differs, or confirm(): `if (!confirm('Change X from A to B?')) { r.value = old; return; }`. Keep focus on the select afterwards.

## 7. 400% zoom (app.css)
```css
html{scroll-padding-top:6.5rem}
@media (max-height:520px){header.top{position:static}}
nav.main{scrollbar-width:thin}                 /* at <=600px: show the scrollbar, or wrap instead of nowrap */
```

## 8. Titles for signed-out screens (login.js)
`document.title = 'Sign in – AVL Tech Hub'`, `'Choose a new password – AVL Tech Hub'`, `'Two-step code – AVL Tech Hub'` when each renders.

## 9. Captions (training.js + files route)
Add purpose `captions` (text/vtt, <=500 KB) and render `h('track', {kind:'captions', srclang:'en', label:'English', src:`/api/files/${id}`, default:true})` inside the `<video>`; add a required "Transcript" textarea (or link) per video, and for SharePoint/link videos a checkbox "Captions are turned on in the source" shown to learners as "Captions: yes / not confirmed". CSP already allows same-origin media/track.

## 10. Toasts (app.js toast())
Errors and validation messages: do not auto-dismiss (keep until dismissed or 30 s); keep the 8 s for "Saved." Use `role="alert"` for errors.
