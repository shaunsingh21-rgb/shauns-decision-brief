# AVL Tech Hub: every word audit (UX writing)

Scope: 797 distinct user-visible strings pulled from `public/js/**/*.js`, `public/index.html` and the server messages the screens show (`HttpError(` and `message:`). Full table: `A3-string-table-all.md` (and `.csv`). Extractor and grader: `extract.js`, `table.js` (not in the repo). Screens were walked in Chromium (phone 390x844, desktop 1000x800) as technician, trainer and leader; screenshots in `shots/`.

## 1. Headline

The copy is already better than most internal tools: plain verbs, "Saved on this device" instead of "queued", no links called "here" (checked: zero), buttons name the thing they act on. The problems are concentrated in four places:

1. **Server error messages that leak developer language** and reach the person unchanged (`Invalid input.`, `Invalid idempotency key.`, `Missing request header.`, `Malformed JSON.`, `correct_index out of range.`, `Field "power_draw" is marked VERIFY...`). The client shows `err.message` as is (`errMsg` in `app.js:16`), and only the equipment editor shows the per-field `details`. Everywhere else a bad form says just "Invalid input."
2. **Words that mean two things**: "update" (equipment firmware update vs the app updating), "lesson" (lesson video vs lesson learned), "draft" (a status vs an AI draft vs "Save as draft"), "pin" (photo marker vs a PIN code), "item" (a specification vs a thing).
3. **Four names for one idea**: team leader / administrator / Leader/Admin / "admin-listed"; and official sources / official domains / official websites / official page.
4. **A status banner that is wrong on first use**: "This material changed or is waiting for review. It must be approved again." is shown the first time a module is submitted (verified), when nothing changed and nothing was approved before.

## 2. Reading level (Flesch-Kincaid, my own calculator in `extract.js`)

| Measure | Value |
|---|---|
| Strings extracted | 797 |
| Graded (4 or more words; labels are not graded, the formula is meaningless on "Save") | 428 |
| Median grade | 3.7 |
| Mean grade | 3.6 |
| Above grade 8 | 50 |
| Above grade 10 | 14 |

The median is fine for a phone app. The 14 above grade 10 are almost all single long words or one-sentence labels (`Approved equipment`, `Invalid idempotency key.`), where syllable count dominates, so grade is a screening tool here, not a verdict. The real reading problems are meaning, not grade: "idempotency", "override", "provenance", "snippet", "OCR", "correct_index". Caveat: the formula was written by me and counts syllables heuristically; treat it as +-1 grade.

Keyword counts in the source (client / server): equipment 151/214, gear 0/0, module 52/166, lesson 20/20, training 28/72, trainee 9/45, learner 0/2, technician 1/5, two-step 30/23, "MFA" appears only in code and key names (good: the UI never says MFA, except the server message that names `MFA_ENCRYPTION_KEY`), provenance 61/60 (code only; the UI says "source" or "Where it came from": good, keep it that way), override 16/33.

## 3. Glossary: the single recommended word for each of 25 terms

| # | Concept | Use | Do not use | Notes from the real screens |
|---|---|---|---|---|
| 1 | A piece of AV hardware in the library | **Equipment** | gear, item, device, asset | Already consistent (0 uses of "gear"). Keep. |
| 2 | One line in an equipment record (power draw, input count) | **Specification** (short: spec) | item, field, key, attribute | "Item / Value / Source" table header and "Add an item" should read "Specification". "Item" also means a thing. |
| 3 | A unit of training | **Module** | lesson, course, training | "Lesson videos" stays (videos inside a module). The tab "Training" is the place; a "module" is what is inside. |
| 4 | A video inside a module | **Lesson video** | clip, tutorial | Keep. |
| 5 | A problem or tip written down | **Issue** / **Lesson learned** (never bare "lesson") | lesson, ticket | "Log an issue or lesson" becomes "Log an issue or a lesson learned". Avoids clash with lesson video. |
| 6 | A trainer confirming someone is competent | **Sign-off** (noun), **sign off** (verb), **signed off** | approval, sign off (noun), certification | Do not use "approve" for people; approve is for material only. |
| 7 | A leader confirming material is trustworthy | **Approve / Approved** (material only) | sign off, verify, validate | Keeps the two controls apart. |
| 8 | Material waiting for a leader | **Needs review** (status), **Submit for review** (button) | waiting for review, pending, awaiting approval | Use "Needs review" (sentence case) everywhere; the badge today is "Needs Review" with capital R. |
| 9 | A value nobody has confirmed | **Not confirmed (VERIFY)** on first mention, **VERIFY** as the badge | unknown, TBD, not identified | Keep the VERIFY badge: it is the product's signature. Use "Not confirmed" in sentences, "Not identified" only on photo pins. |
| 10 | Where a value came from | **Source** (Manufacturer / Team / AI-drafted / VERIFY) | provenance, origin, "Where it came from" | Pick **Source** for the column and the field label; today the label is "Where it came from" in two places and "Source" in three. |
| 11 | The web page a value was copied from | **Web address** (field label: "Web address of the source") | URL, source link, official page | "https://" hint is fine; the word "URL" is not plain. |
| 12 | A person doing training | **Trainee** | learner, technician (for the role), student | Server has two "learner"; change them. |
| 13 | A person who scores and signs off | **Trainer** | instructor, assessor | Keep. |
| 14 | The person who runs the team and the app | **Team leader** in all running text; role name stays "Leader/Admin" | administrator, admin, boss | Today: "administrator" (12 strings), "team administrator", "team leader", "Leader/Admin", "admin-listed". Pick team leader. |
| 15 | Second sign-in step | **Two-step sign-in** | MFA, 2FA, authentication code | Already consistent. Rename the field "Authentication code" to "6-digit code". Name the app type once ("authenticator app"). |
| 16 | The 6-digit number | **Code** (6-digit code) | token, OTP | |
| 17 | One-time backup codes | **Recovery codes** | backup codes | Consistent. Do not reuse "backup" (it means the server backup). |
| 18 | Saving to the server | **Backup** (server data copy) only | | Never use "backup" for recovery codes or for the offline copy. |
| 19 | Changes waiting to go to the server | **Saved on this device, waiting to send** (noun: waiting changes) | queue, sync (as verb to the person), pending | "Sync" remains as the tab and button name only; explain once: "Sync means sending your saved changes." |
| 20 | Changes the server refused | **Needs attention** | rejected, failed, conflict | Today "Heads up", "need attention", "not applied", "did not accept". Pick Needs attention + one explanation. |
| 21 | Working with no signal | **Offline** | disconnected, no connection | "Offline" is good. |
| 22 | Firmware or software release for a unit | **Update** only in the Updates tab; in sentences about the app say "new version of the app" | update (for the app) | The toast "The app was updated. Reload" collides with the Updates tab. |
| 23 | A photo with labelled markers | **Photo panel** (the markers: **labels**, not pins, in sentences) | pin (alone), hotspot | "Pin" reads as a PIN code to non-developers. Keep "pin" only if the button reads "Add a label to the photo". See screen 8. |
| 24 | A leader approving despite VERIFY | **Approve with VERIFY items** | override, approve anyway | "Override" is jargon and sounds like bypassing security; the rule is a decision with a recorded reason. |
| 25 | Sites trusted for Manufacturer values | **Official websites** | official domains, source domains, admin-listed | Four names today. |

Extra decisions: "Log" for issues, "Record" for updates, "Add" for equipment is fine (each is the natural verb) but use "Add" for every create button in forms so the pattern is learnable. Use "Remove" for taking something off a list and "Delete" only when it is gone for good and the confirmation says so; "Discard" only for unsent changes.

## 4. The 40 worst strings, with replacements

Numbered by severity (1 worst). "Where" names the file and what triggers it. Replacements keep the app's rules: never blame, say what happened, say what to do next, no developer words.

| # | Current | Where | Problem | Replacement |
|---|---|---|---|---|
| 1 | `Invalid input.` | server `lib/validate.js:39`; shown by every form except the equipment editor | Blames, gives no clue which field. The server already sends `details`; most screens drop them | `Some of what you entered needs fixing: [first detail].` Show the first `details[].message` in every form (client change: `errMsg`). |
| 2 | `Something went wrong.` | `app.js:16`, server 500 | No next step | `That did not work, and we do not know why. Try again. If it keeps happening, tell your team leader what you were doing.` |
| 3 | `You appear to be offline. This action needs a connection.` + `Open it once while online to save it for offline use.` | Account page when offline (verified, `t11-account.png`) | Red error on a normal situation; "action"; "it" has no noun | `You are offline, and this page is not saved on your phone yet. Reconnect and open it once. After that it opens offline.` Use a neutral notice, not red. |
| 4 | `This material changed or is waiting for review. It must be approved again.` | `training.js:42`, equipment `:40`, panels `:140` | Wrong on first submission (verified): nothing changed and nothing was approved before | If never approved: `This module is waiting for a team leader to approve it.` If approved before: `This module was edited after it was approved, so it needs approval again.` |
| 5 | `Invalid idempotency key.` / `That key was used for a different request.` | `middleware/idempotency.js` | Jargon, not actionable | `Something went wrong sending this change. Reload the page and try again.` (Never mention keys.) |
| 6 | `Missing request header.` | `middleware/security.js:30` | Developer text | `Your sign-in looks out of date. Reload the page and sign in again.` |
| 7 | `Malformed JSON.` | `index.js:82` | Developer text | `That could not be read. Reload the page and try again.` |
| 8 | `correct_index out of range.` | `routes/lessons.js:64` | Raw field name | `Choose which answer is correct (1 to [n]).` |
| 9 | `Field "power_draw" is marked VERIFY, so it must have no value.` | `routes/equipment.js:23` | Raw key, "field", rule without a way out | `"Power draw" is marked VERIFY, so leave its value empty. To enter a value, change its source to Team or Manufacturer.` |
| 10 | `Field "x" is marked manufacturer, so it needs a source URL.` | `equipment.js:26` | Lowercase "manufacturer", URL jargon | `"X" comes from the manufacturer, so add the web address of the page it came from.` |
| 11 | `...that site is not on the admin-listed official domains.` | `equipment.js:28`, `panels.js:25`, `install.js:25` | Jargon (admin-listed, domains); dead end | `That website is not on your team's list of official websites. Ask your team leader to add it, or choose Team as the source.` |
| 12 | `Password needs: must not contain your username.` | `routes/auth.js:16` (reproduced when I tried a password containing "boss") | Ungrammatical ("needs: must"), blames | `Choose a different password. It must be at least 12 characters and must not contain your username.` (build from the failed rules only) |
| 13 | `Invalid username or password.` | `auth/local.js:73` | Blames; no next step (keep the same message for both, that is a security rule) | `That username and password do not match. Check both and try again. Forgotten? Ask your team leader to reset it.` |
| 14 | `Current password is incorrect.` and `That password is not correct.` | `auth.js:107`, `mfa.js:15` | Two wordings for one thing; "incorrect" blames | `That is not your current password. Check it and try again.` (use in both) |
| 15 | `That code was not accepted.` (sign-in) vs the longer one in `mfa.js:39` | `auth.js:71` | The sign-in version gives no help, the setup version does | Use for both: `That code did not work. Wait for the next code in your app and try again. Check that your phone's clock is set automatically.` |
| 16 | `Too many failed attempts. Try again in N minute(s), or ask an administrator to unlock the account.` | `auth.js:77` | "(s)" hack; "failed attempts" | `This account is locked for N minutes after too many wrong tries. Wait, or ask your team leader to unlock it.` Handle singular: "1 minute". |
| 17 | `Too many sign-in attempts from this device. Try again later.` | `auth.js:40` | "later" is vague | `Too many tries from this phone. Wait a few minutes and try again.` |
| 18 | `Too many requests. Slow down.` | `index.js:61` | Commanding tone | `You are sending requests faster than the app allows. Wait a minute, then try again.` |
| 19 | `Search/AI limit reached for this hour.` | `external.js:16` | Slash, no next step | `You have used this hour's searches and AI drafts. Try again in an hour, or type the details yourself.` |
| 20 | `Heads up: one of your offline changes was not applied because someone else changed the same thing more recently.` | `app.js:55` | Long, passive; "Heads up" not used elsewhere | `One change you made offline was not used. A teammate edited the same thing after you, so their version was kept. [See details]` |
| 21 | `Someone else changed this more recently, so their version was kept and your change to "X" was not applied.` | `app.js:114`, `sync.js:79` | Same; no next step | `Not saved: a teammate edited "X" after you. Their version was kept. Open it and redo your change if you still need it.` |
| 22 | `Sign-off requirements are not met.` (then bullet list) | `routes/training.js:201` | Heading is cold; list items say "is unscored, needs 2+" | `Not ready to sign off yet. Still needed:` and list items: `Quiz: best score is 60%, needs 80%.` `Skill "Set a level": not scored yet, needs 2 or more.` |
| 23 | `Answer every question first (1 one is still blank).` | `training.js:57` (reproduced) | Grammar error "1 one" | `Answer every question first. 1 is still blank.` / `3 are still blank.` |
| 24 | `Unknown equipment.` | `issues.js:12` | Unhelpful | `That equipment is no longer in the library. Choose another, or leave it blank.` |
| 25 | `Not found.` / `User not found.` / `Question not found.` etc. (9 variants) | routes | No cause or next step | `We cannot find that. It may have been deleted. Go back and refresh the list.` |
| 26 | `That id already exists.` / `Duplicate field keys.` | `equipment.js:57,59` | Developer words | `That ID is already used. Choose another.` / `Two specifications have the same name. Give each its own name.` |
| 27 | `Already approved.` / `Already on.` / `Two-step sign-in is not on.` / `Start setup first.` | `equipment.js:97`, `mfa.js` | Curt, ambiguous subject | `This is already approved. Nothing more to do.` / `Two-step sign-in is already on for you.` / `Two-step sign-in is not turned on for you.` / `Start the setup from the first step.` |
| 28 | `Say what is being uploaded: photo, document or video.` | `files.js:38` | Order to the person for a code mistake | `Choose whether this file is a photo, a document or a video.` |
| 29 | `Enter a valid https link.` | `lessons.js:42` | "valid" blames | `Paste a web address that starts with https://` |
| 30 | `Embeds must come from: [hosts].` | `lessons.js:39` | Jargon "embeds" | `Video links must come from SharePoint ([host]). In SharePoint choose Share, then Embed, and paste that link.` |
| 31 | `Lesson videos live in SharePoint. Checkpoints on SharePoint and link videos can't pause the video for you, so answer them as you reach each time. Uploaded videos pause automatically.` | `training.js:122` | Garbled ("as you reach each time"); two jobs in one sentence | `Videos are kept in SharePoint. The video cannot stop by itself for questions on SharePoint or link videos, so answer each question when the video reaches its time. Uploaded videos stop for you.` |
| 32 | `Approve anyway (override)` / `Override reason (required, at least 5 characters)` | `equipment.js:75-76`, panels `:106` | "Override" jargon; sounds like bypass | `Approve with VERIFY items still open` / `Why is this safe to approve? (required, at least 5 characters)`. Keep the audit wording "approved despite VERIFY items" (already plain). |
| 33 | `Add an item (lowercase letters, digits, underscore)` and column `Item` | `equipment.js:98,44` | "item", "digits", exposes the storage key | `Add a specification` with hint `Type a short name, like power draw. Letters, numbers and underscores only.` Column: `Specification`. |
| 34 | `Check the file` / `Import now` / `Imported.` | `admin.js:119-133` | "Check the file" does not say it is a safe preview | `Preview (nothing changes)` then `Import now`. |
| 35 | `Your role requires two-step sign-in, but this server is missing its key. Ask your administrator.` / `...MFA_ENCRYPTION_KEY` in roles message | `security.js:45`, `auth.js:56`, `roles.js:29` | Names an environment variable; "this server is missing its key" | To a person: `Two-step sign-in cannot be used until your team leader finishes setting it up on the server. Ask them to check the deployment guide.` Keep the variable name only in the admin screen / logs. |
| 36 | `Open an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password...), add an account, and scan this picture.` | `account.js:53` (FK 16.5, longest) | One long sentence | `Open your authenticator app (for example Microsoft Authenticator). Choose Add account, then scan this picture.` |
| 37 | `Place pin here` / `Pin position marker...` / `Placing a pin.` | `panels.js:44-64` | "pin" reads as PIN code; instructions are long | `Put the label here` ; `Tap the photo where the label goes.` Keyboard instruction as a separate hint. |
| 38 | `Your role can't add equipment. Ask a team leader if you need that.` and similar "Your role..." lines | `app.js:96` and 6 more | "role" is internal; fine tone, good next step | Keep, but align with glossary: `You do not have permission to add equipment. Ask your team leader if you need it.` |
| 39 | `Trainee` list shows the leader, other trainers and yourself (`Sample Boss`, `Sample Trainer` appear in the pickers) | `training.js:101` | Content, not wording, but it makes the instruction "Choose a trainee" unclear | Hide yourself and show `(you)`. Needs a client change; wording stays. |
| 40 | `Reset.` / `Imported.` / `Discarded.` / `Approved.` single-word confirmations, and `Logged.` | many | Terse; "Reset." is the confirmation button text in one place (`admin.js:68`) and means yes | Button: `Yes, reset to defaults`; toasts: `Reset to the original permissions.` / `Imported.` is fine. Pattern: confirm buttons repeat the action. |

Smaller, apply when convenient: `Heads up`/`Dismiss` vs `Discard`/`Remove` (pick Dismiss for notices only); `unscored` vs `not scored` (training.js:109 and server) use "not scored"; `Needs Review` vs `Needs review`; `Sample Boss · Leader/Admin` header is fine; `Username` column header wraps to "Userna me" in the People table at 1000px (see `l03-admin.png`); the role dropdown clips "Leader/Admin" in the same table; navigation tab "Issues & lessons" is cut off on a 390px phone ("Issues &", `t11-account.png`), the tab strip scrolls but nothing signals it; "Logged." and "Saved on this device..." appear as two stacked toasts (`t10-offline-issue.png`): show one.

Em dashes: 16 strings use " — " as a separator (`Offline — 2 changes waiting to sync`). It reads as a pause in speech and is fine for sighted users; for screen readers prefer a colon or full stop. Low priority.

## 5. Rewritten copy deck: the 10 screens that matter most

Format: current text on the left only where it changes. New text is ready to paste. Placeholders in [brackets] are runtime values.

### Screen 1. Sign in
- Title: `AVL Tech Hub`; subtitle `ITS Events: training and equipment`
- Fields: `Username`, `Password`
- Button: `Sign in`
- Help: `Your team leader creates your account. Forgotten your password? Ask your team leader to reset it.`
- Wrong details: `That username and password do not match. Check both and try again.`
- Locked: `This account is locked for [N] minutes after too many wrong tries. Wait, or ask your team leader to unlock it.`
- Noscript: `AVL Tech Hub needs JavaScript turned on to work.`

### Screen 2. Choose your own password (first sign-in)
- Title: `Choose your own password`
- Notice: `You signed in with a temporary password. Choose your own before you continue.`
- Fields: `Temporary password`, `New password`, `Repeat the new password`
- Hint: `At least 12 characters. It must not contain your username.`
- Mismatch: `The two new passwords are different. Type the same one twice.`
- Button: `Save password`

### Screen 3. Two-step sign-in code
- Title: `Two-step sign-in`
- Label: `6-digit code`; hint `Open your authenticator app and type the 6-digit code for AVL Tech Hub.`
- Recovery: label `Recovery code`; hint `Type one of the recovery codes you saved when you set up two-step sign-in. Each code works once.`
- Toggle: `Use a recovery code instead` / `Use my authenticator app instead`; Back button: `Back`
- Wrong code: `That code did not work. Wait for the next code in your app and try again. Check that your phone's clock is set automatically.`

### Screen 4. Equipment library (home)
- Title: `Equipment`; button `Add equipment`
- Intro: `Every value shows its source: Manufacturer, Team, AI-drafted or VERIFY (not confirmed). Nothing is guessed.`
- Search label: `Search equipment`
- Row badge: `[n] VERIFY` becomes `[n] not confirmed` (keep the amber VERIFY chip on the detail page)
- Empty: `No equipment yet. Choose Add equipment to start.` / `Nothing matches "[text]".`
- Offline: `You are offline. This shows what was saved on your phone.`

### Screen 5. Equipment record
- Banner (VERIFY): `[n] specification(s) are marked VERIFY (not confirmed): [list]. Do not rely on them until someone confirms them from a source.` (use real singular/plural)
- Section: `Specifications`; columns `Specification`, `Value`, `Source`
- Empty: `No specifications yet.`
- Buttons: `Edit`, `Submit for review`; leader: `Approve` / `Approve with VERIFY items still open`
- Review banner: never approved: `This record is waiting for a team leader to approve it.` Edited since: `This record was edited after it was approved, so it needs approval again.`
- Edit hint: `Saving changes sends this record back to Needs review.`
- Approval history empty: `Not approved yet.`

### Screen 6. Installation assistant
- Title: `Installation assistant` (keep); progress: `[n] of [m] steps done. Your ticks are saved to your account.`
- Unapproved: `These steps are not approved yet. Check them against the manufacturer's manual before you rely on them.`
- Empty: `No installation steps yet. Add them from the manufacturer's manual or your team's own procedure.`
- Button: `Edit steps`; editor: `Step [n]`, `What to do`, `Web address of the source (needed for Manufacturer steps)`.

### Screen 7. Issues and lessons learned
- Title: `Issues and lessons learned`; collapsed form summary: `Log an issue or a lesson learned`
- Fields: `Type` (Issue / Lesson learned), `Title`, `What happened (optional)`, `Related equipment (optional)`
- Filter label: `Show`; options `All`, `Issues`, `Lessons learned`
- Save: `Log it`; toast: `Saved.` and, offline only: `Saved on this phone. It will send when you are back online.` (one toast, not two)
- Empty: `Nothing logged yet.`
- Row action: `Mark resolved` / `Reopen`

### Screen 8. Photo panel (labels on a photo)
- Section title: `Photo panels`; empty `No photo panels yet. A panel is a photo with labels, and each label shows its source.`
- Add: field `Name for the new panel`, buttons `Take photo`, `Choose photo`; hint `Your phone removes the location from the photo before it is saved.`
- Placing: `Tap the photo where the label goes. With a keyboard: arrow keys move the marker, Enter places it, Escape cancels.`
- Form: `What is it?`; `Not identified yet (VERIFY). No label needed.`; `Use the manufacturer's name for it.`; button `Save label`
- Quiz: `Quiz me needs at least two labels from the Manufacturer or Team.`

### Screen 9. Module (training)
- Banners: see glossary; status chips `Draft`, `Needs review`, `Approved`
- Quiz: heading `Written quiz`; line `Pass mark [80]%. Your best score: [x]%.` / `Your best score: not taken yet.`
- Button: `Submit answers`; incomplete: `Answer every question first. [n] still blank.`; result: `You scored [x]%. You passed.` / `You scored [x]%. You need [80]% to pass. Look back over the material and try again.`
- Offline: `Your answers are saved on this phone. They will be marked when you are back online, and your score will appear on this page.`
- Practical: `Practical skills`; `A trainer scores each skill from 0 to 3. Every skill needs a 2 or more.`; `not scored`
- Trainer card: title `Score and sign off`; `You cannot score or sign off yourself.`; field `Trainee`; `Choose a trainee`; button `Save score`; note `Note for the record (optional)`; `Sign off [trainee]` / `Renew the sign-off`
- Rubric: `0 Not shown yet`, `1 Needs coaching`, `2 Competent with little help`, `3 Does it independently` (proposal; the rubric wording is an open question in DECISIONS F2, so keep the app's current labels if the team has not chosen)

### Screen 10. Sync and offline messages (header pill and Sync page)
- Pill: `All changes saved` / `Syncing...` / `Offline: showing saved data` / `Offline: [n] changes waiting to send` / `[n] changes need attention` / `Sign in again to send [n] changes`
- Page title `Sync`; explainer: `When you are offline, your changes are saved on this phone and sent in order when the connection is back. Sign-offs, approvals and quiz results are never merged or overwritten: each one is recorded under your name.`
- Buttons: `Send now` (was `Sync now`, keep the tab name Sync), `Try again`, `Discard`
- Needs attention: `This change was not accepted: [reason]. Try again, or discard it.`
- Discard confirm: `Discard this change? It will not be saved anywhere.`
- Empty: `Nothing is waiting.`
- Conflict toast (see worst strings 20 and 21).
- Sign out with unsent work: `[n] change(s) have not been sent. If you sign out now they will be lost. Sign out anyway?` (singular/plural handled)

## 6. Accessibility of wording

- Links named "here": none found (checked all 797). Links are "← All equipment", "Updates", "Issues & lessons", "Official page": good. Replace "Official page" with "Open the manufacturer's page" where the target is a manufacturer; keep an accessible name that says it opens an external site.
- Buttons repeat the object through `aria-label` (`Approve "X"`, `Remove question ...`): good practice, keep.
- "Show" (audit log detail toggle, 30+ identical links in a row): name it `Show details for [event]`.
- Unicode ticks (`✓`, `⚠`) in the skill matrix: the cell labels already say "signed off" in `aria-label` (good).
- Em dash separators: low priority, see above.

## 7. How I checked (and what the numbers cannot tell you)

Walked in Chromium against my own server: sign in with a temporary password, forced password change, equipment list and record, installation ticks, issue logging, going offline (header pill, offline tick and log, Account page offline), quiz fail and pass, trainer score and sign-off, leader approval, skill matrix, Admin page, the Add equipment first step. Not tested: the AI draft, the web search step, OCR on a real label, real SharePoint, a real phone, a screen reader. Reading grades are screening numbers from my own calculator.
