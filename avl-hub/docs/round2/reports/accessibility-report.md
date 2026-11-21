# AVL Tech Hub: accessibility compliance audit (WCAG 2.2 A/AA, Section 508)

Auditor: r2-accessibility. Date: 2026-11-21. Build: working tree of `avl-hub/` (read-only). Own server on 127.0.0.1:4203, own data, SAMPLE content only.
Tool: axe-core 4.14.1 (tags wcag2a, wcag2aa, wcag21a/aa, wcag22aa, section508, EN-301-549, best-practice) in Playwright/Chromium, plus scripted manual-style checks. The app's CSP blocked nothing: axe is injected by the protocol.

## 0. Scope actually run

* **318 axe runs over 44 distinct screens/states**, each in 390 and 1000 px, light and dark (raw: `axe-raw-all.json`). Roles: admin, trainer, technician, viewer.
  Screens: sign-in (+error), forced password change (+error), two-step code, recovery-code, wrong-code error, equipment list/detail/edit mode/installation steps editor, wizard steps 1 to 4, photo panel view/place/pin form/pin selected/quiz/quiz answered, training overview, module (learner and trainer, uploaded + SharePoint + link video, checkpoints), quiz result, updates, issues (+form open), skill matrix, admin (people, roles editor new/edit, sources, audit, import report, temporary-password notice), account (two-step off, step 1, QR, recovery codes, on), forced two-step enrolment, sync page, offline chip, toast.
* Extra modes on 6 key pages: forced-colors active (light, dark), reduced motion, `prefers-contrast: more`, 320x256 (400% zoom), 640x400 (200%), WCAG 1.4.12 text-spacing override. Result: no violation appears in any mode that is not already in the default run.
* Scripted checks: 373 keyboard focus stops over 12 routes x 2 widths; focus management over 8 transitions; live-region capture; headings, landmarks, titles; target size on 12 routes x 2 widths; reflow and clipping on 12 routes; contrast of control borders and focus ring; autocomplete/paste; error handling.

## 1. Result in one paragraph

The app is in better shape than most internal tools: **axe finds only 3 rules, 2 real defects, across 318 runs**, and zero colour-contrast, label, name, landmark, heading, ARIA-validity or target-size violations. The automated tools cannot see the larger problems, which my scripted checks did find: the **sync chip has no accessible name on every signed-in screen**, **form-control borders fail 1.4.11 (1.38:1)**, **a single arrow-key press on the People "role" dropdown silently changes a person's role**, **focus is dropped to the page top after most re-renders**, **errors are not tied to fields** ("Invalid input." names no field), and **uploaded lesson videos have no way to carry captions**, which Section 508 treats as a hard requirement for training video.

## 2. (a) Every axe violation

| # | axe rule | Where (selector) | Screens (runs) | WCAG / 508 | Impact | Exact fix |
|---|---|---|---|---|---|---|
| A1 | `link-name` | `a.syncline` (the "All changes saved" chip, `app.js` `syncLine()`) | every signed-in screen, 282 runs | 2.4.4, 4.1.2; 508 502.3.1 / 504.2 | **serious** | The element is `<a role="status" aria-live="polite">`. A link may not take `role=status`; the role strips the link semantics and name-from-content, so the focusable control is exposed with no name. Keep the `<a>` plain and move the live region to a sibling `<span class="vh" role="status">` (snippet 1 in `fix-snippets.md`). |
| A2 | `aria-allowed-role` | `a.syncline` | same 282 runs | 4.1.2 (best practice) | minor | Same fix as A1. |
| A3 | `label-content-name-mismatch` | `button.pin.b-team`, `.b-manufacturer`, `.b-ai` (not `.b-verify`, whose letter differs) in `panels.js` `pinBtn` | photo panel view / place / form / pin selected / quiz, 44 runs, 132 nodes | 2.5.3 Label in Name (A, WCAG 2.1+) | **serious** | Visible text is "1T" (number plus a source letter); accessible name is "Pin 1: SAMPLE input 1. Source: Team". Voice-control users who say "click 1" or "click 1 T" can fail. Make the source letter a CSS `::after` from `data-src` and start the name with the number: `aria-label="1. SAMPLE input 1, source Team"` (snippet 3). |

Zero violations (clean on every run): sign-in, forced password change, two-step code, recovery code, wrong-code error, forced two-step enrolment. All other screens differ only by A1 to A3.

**axe "incomplete" (needs a human), reviewed:**
* `color-contrast` (173): all are the header nav links partly under a horizontal scroll strip at 390 px. Measured by hand: white on `#104d3a` is 9.8:1 (light), white on `#1c7a5c` is 5.3:1 (dark). Pass.
* `video-caption` (28) and `frame-tested` (28): the uploaded `<video controls>` has **0 `<track>` elements** (confirmed in the DOM); the SharePoint iframe cannot be inspected cross-origin. See section 4, criteria 1.2.x.

## 3. What axe cannot catch: scripted findings (not in the table above)

| # | Finding | Evidence | WCAG | Impact |
|---|---|---|---|---|
| M1 | **Control borders too faint.** Inputs, selects, textareas and secondary buttons use `--line` for their only visible boundary. | Measured on a white card: border `#d3ded7` is **1.38:1** (light), `#2c3d37` is **1.41:1** (dark). 3:1 required. Primary buttons 9.8 / 3.08, danger 7.6 / 8.1, pins ring OK. | 1.4.11 | **serious** (every form, low-vision users) |
| M2 | **Role dropdown commits on the first key press.** `admin.js` line 35 PATCHes on `change`; a native select fires `change` on ArrowUp/ArrowDown in Chrome. | One ArrowDown on a user's role select sent `PATCH /users/<id> {"role":"technician"}` immediately (sandbox admin changed to technician), no confirmation, and focus then fell to `<body>`. | 3.2.2, 2.1.1 (usable by keyboard), also a safety bug | **serious** (and a privilege-change risk) |
| M3 | **Focus lost after re-render.** Route changes are handled well (focus moves to `<main>`), in-page ones are not. | Active element after: nav click = `main` (good); Edit click = `body`; Cancel = `body`; Escape in pin-place mode = `body`; Quiz me = `body`; failed sign-in = `body` (the clicked button is `disabled` by `busyGuard`, which drops focus and never restores it). Good: Add a pin focuses the marker; Place pin here focuses the first form field. 5 of 8 transitions lose focus. | 2.4.3, 3.2.2 | **serious** for keyboard and screen-reader users (restart from the top of the page) |
| M4 | **Errors not tied to fields; validation unhelpful.** Zero `aria-invalid`, zero field-level `aria-describedby` for hints/errors in the code base. | Issues form, empty Title: result toast "Invalid input." (the server's `details` are dropped by `errMsg`), no field named, focus on `<body>`, toast vanishes in 8 s. Wizard step 2 empty name: only a toast. Password rules ("At least 12 characters. Must not contain your username.") sit in a `div.hint` with no `id` and no `aria-describedby`. Good: login and password-change errors are `role=alert` regions present before filling and were announced in my mutation capture ("Invalid username or password."; "The new passwords do not match."). | 3.3.1, 3.3.2, 3.3.3, 1.3.1 | **moderate** (all form users, SR users most) |
| M5 | **No captions or transcript path for lesson videos.** | Uploaded video: `<video controls>` with 0 `<track>`; trainer UI and page text never mention captions or transcript; SharePoint/link videos have no "captions available" attestation. CSP already allows same-origin media/track. | 1.2.2, 1.2.3, 1.2.5; 508 (video must be captioned) | **high** for any deaf or hard-of-hearing learner and for the college's procurement review |
| M6 | **400% zoom and sticky header.** At 320x256 the sticky header is 102 px = 40% of the viewport; no `scroll-padding-top`. At 390 and below the nav is `nowrap` with the scrollbar hidden: 4 of 7 links are off-screen. | No page-level horizontal scroll on any of 12 routes at 320 and 640 px (good). Worst obscured focus: pin 3 is 79% hidden under the header at 320x256, never fully hidden. | 1.4.10 (partial), 2.4.11 (passes AA; fails AAA 2.4.12) | **moderate** (low-vision phone/zoom users) |
| M7 | **Toasts carry the only validation message and vanish in 8 s.** They are `<button class="toast" aria-label="msg (tap to dismiss)">` inside a polite live region. | Source `app.js` `toast()`; observed for wizard step 2. | 2.2.1, 4.1.3, 3.3.1 | moderate |
| M8 | **Signed-out screens share one page title.** | Sign-in, forced password change and two-step code screens all report `document.title = "AVL Tech Hub"`. All 12 signed-in routes have unique, descriptive titles. | 2.4.2 | low |
| M9 | **Repeated, row-less button names.** | Admin: "Reset password" x5, "Disable" x4, "Edit" x3, "Reset to defaults" x3; module: "Remove video" x3, "Add checkpoint" x3; issues: "Mark resolved" x2. Some already carry row names ("Delete role X"), these do not. | 2.4.4 / 2.5.3 spirit, 4.1.2 | low to moderate (SR button list, phone card layout) |
| M10 | **Focus ring on the green header is 2.98:1** (`#c47f00` on `#104d3a`); on white 3.29, on the page 3.05, dark 9.45. | Computed. | 1.4.11 (focus indicator, borderline) | low |

Also verified good: skip link is the first Tab stop and moves focus to `<main>`; single `<h1>` and logical h2/h3/h4 on all 12 routes; landmarks `header`, `nav[Main]`, `main` (no unlabeled duplicates); `lang=en`; viewport allows zoom; no orientation lock in the manifest; `prefers-reduced-motion` honoured (0 animations, 0s transitions); 0 focus stops without a visible indicator (only the browser's native `<video>` controls draw their own); no keyboard trap in 373 stops (120 Tabs per page); text-spacing override: 0 clipped elements on 12 routes; forced-colors: pins, cross, badges and focus remain visible (screenshots in `shots/forced-*.png`); no dragging anywhere (`draggable=false`, pins placed by click or keyboard cross, so 2.5.7 is met); tables keep table semantics at phone width (verified with an ARIA snapshot at 390 px); login fields use `username`, `current-password`, `new-password`, `one-time-code` tokens and a synthetic paste event is not blocked.

## 4. (b) VPAT-style conformance summary (WCAG 2.2, Levels A and AA)

Terms: **Supports** = no defect found by tool or script; **Partially** = defect in some places; **Does not support** = defect that blocks users; **N/A** = feature absent. "Manual" = needs a human or assistive-technology pass that I could not do (section 6). 4.1.1 Parsing was removed in WCAG 2.2.

| SC | Level | Result | Evidence and remarks |
|---|---|---|---|
| 1.1.1 Non-text Content | A | Supports | axe image-alt/role-img/svg-img clean on all 44 screens; panel photo alt "title: photo of equipment"; QR has alt and a typed-key alternative; pins are named. Manual: alt quality. |
| 1.2.1 Audio-only / video-only (prerecorded) | A | N/A | No audio-only or silent-video feature. |
| 1.2.2 Captions (prerecorded) | A | **Does not support** | Uploaded `<video>` has 0 `<track>`, no caption upload, no transcript field (M5). SharePoint/link videos: unknown, no attestation. |
| 1.2.3 Audio description or media alternative | A | **Does not support** | No transcript or described version (M5). |
| 1.2.4 Captions (live) | AA | N/A | No live media. |
| 1.2.5 Audio description (prerecorded) | AA | **Does not support** | Same as 1.2.3. Needed only where video content is not fully conveyed by its audio. |
| 1.3.1 Info and Relationships | A | Partially | Headings, lists, table headers, landmarks, fieldset/legend good. Hints and required state not programmatically linked (M4); chip role override (A1). |
| 1.3.2 Meaningful Sequence | A | Supports | DOM order matches visual order; focus order tracks it (373 stops). |
| 1.3.3 Sensory Characteristics | A | Supports | Quiz says "highlighted pin 3" but gives the number. Pin quiz is inherently visual; photos have descriptive alt (test/exercise exception). |
| 1.3.4 Orientation | AA | Supports | No lock (manifest has no `orientation`). |
| 1.3.5 Identify Input Purpose | AA | Supports | Autocomplete tokens on every credential field. |
| 1.4.1 Use of Colour | A | Supports | Provenance badges are text; pins carry a source letter and a dashed border for VERIFY; chip, approval and quiz feedback are text; links underlined. |
| 1.4.2 Audio Control | A | Supports | No auto-playing audio (`preload=metadata`). |
| 1.4.3 Contrast (Minimum) | AA | Supports | axe `color-contrast`: 0 violations in 318 runs, light and dark; incompletes verified by hand. |
| 1.4.4 Resize Text | AA | Supports | rem units, zoom allowed, 200% (640 px) clean. |
| 1.4.5 Images of Text | AA | Supports | None in the UI. |
| 1.4.10 Reflow | AA | Partially | No page-level horizontal scroll at 320 or 640 px on 12 routes; data tables scroll inside their own container (allowed). The nav strip hides 4 of 7 links with no visible scrollbar; sticky header takes 40% of a 256 px viewport (M6). |
| 1.4.11 Non-text Contrast | AA | **Does not support** | Control borders 1.38:1 and 1.41:1 (M1). Focus ring borderline on header (M10). |
| 1.4.12 Text Spacing | AA | Supports | Override applied on 12 routes: 0 clipped, 0 horizontal scroll. |
| 1.4.13 Content on Hover or Focus | AA | Supports | Only native `title` tooltips (browser-controlled, exempt). Note: the matrix column `title` is pointer-only. |
| 2.1.1 Keyboard | A | Partially | Every function reachable (pin placement has an arrow-key marker). The role select is unusable by keyboard without committing a change (M2). |
| 2.1.2 No Keyboard Trap | A | Supports | 120 Tabs per page, no trap, Escape leaves pin placement. |
| 2.1.4 Character Key Shortcuts | A | Supports | Only arrows/Enter/Escape inside the focused marker. |
| 2.2.1 Timing Adjustable | A | Partially | Messages that carry validation info time out at 8 s (M7). Two-step ticket (5 min) and 12 h idle are security-essential. |
| 2.2.2 Pause, Stop, Hide | A | Supports | No moving or auto-updating content other than the sync chip text. |
| 2.3.1 Three Flashes | A | Supports | None. |
| 2.4.1 Bypass Blocks | A | Supports | Skip link first, works. |
| 2.4.2 Page Titled | A | Partially | 12 of 12 routes unique; 3 signed-out screens share a title (M8). |
| 2.4.3 Focus Order | A | Partially | Order is logical; focus is lost after in-page re-renders (M3). |
| 2.4.4 Link Purpose (in context) | A | Partially | Mostly clear; repeated "source" and unnamed row buttons (M9); the sync chip has no name (A1). |
| 2.4.5 Multiple Ways | AA | Supports | Main nav plus equipment search. |
| 2.4.6 Headings and Labels | AA | Supports | Single h1, descriptive h2/h3, every control labelled (axe label rules clean). |
| 2.4.7 Focus Visible | AA | Supports | 0 of 373 stops without an indicator (excluding native video controls). |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Supports | Never fully hidden; worst 79% hidden at 320x256 (M6). Advisory for AAA 2.4.12. |
| 2.5.1 Pointer Gestures | A | Supports | Single-pointer only. |
| 2.5.2 Pointer Cancellation | A | Supports | Click-based activation. |
| 2.5.3 Label in Name | A | **Does not support** (pins) | axe A3, 132 nodes. |
| 2.5.4 Motion Actuation | A | N/A | No motion input. |
| 2.5.7 Dragging Movements | AA | Supports | No drag; click/tap/keyboard alternative is the only method. |
| 2.5.8 Target Size (Minimum) | AA | Supports | All targets at least 24 px; 98% at least 44 px. Exceptions: standalone back links 20 px tall (spacing exception), native radios 21 to 24 px inside a 44 px clickable row. |
| 3.1.1 Language of Page | A | Supports | `lang=en`. |
| 3.1.2 Language of Parts | AA | Supports | English only. |
| 3.2.1 On Focus | A | Supports | No context change on focus. |
| 3.2.2 On Input | A | **Does not support** | Role select commits and redraws on change (M2). |
| 3.2.3 Consistent Navigation | AA | Supports | Same nav on all pages. |
| 3.2.4 Consistent Identification | AA | Supports | Same names for same functions. |
| 3.2.6 Consistent Help | A | N/A | The app offers no help mechanism. Recommendation: add a "Who to ask" link in the same place on every page. |
| 3.3.1 Error Identification | A | Partially | Login/password errors good; field-level and server validation errors are not identified (M4). |
| 3.3.2 Labels or Instructions | A | Partially | Labels yes; hints unlinked; required fields unmarked except native `required` on login (M4). |
| 3.3.3 Error Suggestion | AA | Partially | Some suggestions (password rules); generic "Invalid input." gives none. |
| 3.3.4 Error Prevention (legal, financial, data) | AA | Partially | Deletes use `confirm()`. Sign-off and approval are append-only with no confirm or review step (reasoned, not tested with users). |
| 3.3.7 Redundant Entry | A | Supports | Wizard carries name, manufacturer and label text between steps; current-password re-entry is a security exception. |
| 3.3.8 Accessible Authentication (Minimum) | AA | Supports | Password managers work (tokens, plain `<form>`), paste allowed, one-time code uses `one-time-code` and accepts paste, no puzzles or CAPTCHA. Remark: recovery-code field sets `autocomplete=off`; paste still works. |
| 4.1.2 Name, Role, Value | A | **Does not support** | A1 (serious, every signed-in screen). |
| 4.1.3 Status Messages | AA | Partially | Persistent polite region plus pre-existing `role=alert` regions work in capture; toasts are buttons with a different aria-label (announcement not verified); chip role bug (A1). Manual with a screen reader. |

Tally of the 55 listed criteria: **Supports 32, Partially 12, Does not support 7, N/A 4.** The 7 "Does not support" rows are 1.2.2, 1.2.3, 1.2.5 (one root cause: no caption/transcript path), 1.4.11, 2.5.3, 3.2.2 and 4.1.2.

**Section 508 (Revised, 2017):** Chapters 5 and 6 incorporate WCAG 2.0 Level A/AA. Of the failing rows, 1.2.2, 1.2.3/1.2.5, 3.2.2 and 4.1.2 are WCAG 2.0 criteria and so count directly against 508; 1.4.11 and 2.5.3 are WCAG 2.1 additions and matter if the college's policy or contract asks for 2.1 or 2.2 AA. The functional performance criteria (without vision, low vision, hearing, limited manipulation) map to the same defects. Which standard the college requires is its decision; the table covers all three.

## 5. (c) Fixes ranked by users helped (code for each is in `fix-snippets.md`)

| Rank | Fix | Users helped | Effort | Closes |
|---|---|---|---|---|
| 1 | Make the sync chip a normal link plus a separate live region | Every screen-reader, switch and voice user on every signed-in page | S (10 min) | A1, A2, 4.1.2, 2.4.4 |
| 2 | Raise form-control borders to at least 3:1 (`--line-ctl`) | All low-vision users on every form | S (15 min) | M1, 1.4.11 |
| 3 | Restore focus after re-render and after busy-guarded clicks | All keyboard and screen-reader users, constantly | M (2 to 3 h) | M3, 2.4.3 |
| 4 | Role dropdown: add Save or confirm, keep focus | Every admin using a keyboard; also prevents silent privilege changes for everyone | S (30 min) | M2, 3.2.2 |
| 5 | Field-level errors: surface server `details`, `aria-invalid`, focus first bad field, associate hints (`field()` helper) | Screen-reader, cognitive and keyboard users on all ~25 forms | M (3 h) | M4, 1.3.1, 3.3.1 to 3.3.3 |
| 6 | Caption track and transcript for uploaded videos; "captions on in source" flag for SharePoint | Deaf and hard-of-hearing learners; unblocks the 508 caption requirement | M (half day) | M5, 1.2.x |
| 7 | Pin accessible names that start with the visible number | Voice-control users on photo panels | S (20 min) | A3, 2.5.3 |
| 8 | 400% zoom: `scroll-padding-top`, static header on short viewports, visible nav scrollbar | Low-vision phone and zoom users | S (30 min) | M6 |
| 9 | Errors in toasts persist; use `role=alert` | Low-vision, slow-reading and screen-reader users | S (30 min) | M7 |
| 10 | Titles for signed-out screens; row-specific button names | All AT users | S (30 min) | M8, M9 |

Fixes 1, 2, 4, 7, 8, 10 together are under 2 hours and remove every axe violation plus 1.4.11, 3.2.2, 2.4.2 and 2.5.3.

## 6. What automated tools cannot judge, and what remains manual

Not done and needing a person:
1. **Screen-reader output.** NVDA/JAWS with Chrome/Edge, VoiceOver on macOS and iOS. Check: how the sync chip, toasts (a `<button>` in a live region), the pin quiz and the QR step are spoken; whether `role=alert` regions announce after a redraw; whether table-as-cards on phone read sensibly.
2. **Real captions review** of the actual lesson videos, and whether the SharePoint player's captions are on.
3. **Voice control** (Dragon, Voice Control on iOS): the pin names (A3) and repeated button names.
4. **Switch / on-screen keyboard** and a real **Windows High Contrast** pass (I used Chromium forced-colors emulation only).
5. **Cognitive and plain-language review** of the on-screen wording (3.1.5 and the AAA criteria are not in scope here).
6. **Uploaded documents** (PDFs in the documents panel) are user content; their own accessibility is outside the app.
7. The cross-origin **SharePoint iframe** contents (axe cannot enter it).
8. Mobile **screen readers with the installed PWA** and the offline service-worker states beyond the chip.

Automated tools find about 30 to 40% of WCAG failures; the clean axe result must not be quoted as "WCAG conformant". It means the structural basics are right.

## 7. Files

* `accessibility-report.md` (this file)
* `axe-raw-all.json` (all 318 axe runs, violations and incompletes), `axe-raw.json`, `axe-raw2.json`, `axe-raw2-mfa.json`, `axe-modes.json`, `axe-issues-form-*.json`, `axe-raw-steps.json`
* `manual-raw-A,B,C,D.json` (structure, reflow, spacing, forced-colors, motion), `manual2-raw-G.json` (keyboard), `manual2-raw-I,N.json` (live regions, errors, contrast), `manual2-raw-M,H,L.json` (statics, focus, video), `focus-obscured.json`, `t5.json`
* `fix-snippets.md` (ready-to-paste fixes), `shots/` (forced-colors, reflow, text-spacing, offline, empty-save screenshots)
* Scripts to re-run: `serve.js`, `seed.js`, `run-axe.js`, `run-axe2.js`, `run-axe3.js`, `manual.js`, `manual2.js`, `t3.js` to `t8.js`
