# Round 3: guides walked as a new user (fresh app, starter files imported, Chromium; phone = iPhone 14 EMULATION 390x664 viewport, desktop 1000x800)
Server: port 4310, fresh DB. Accounts made through the Admin screen; temporary passwords used at first sign-in. Scripts: l*.js (leader), t*.js (trainer), p*.js (phone technician). Screenshots in shots/.
NOTE: the repo working tree changed during my run (uncommitted edits to app.js, dom.js, app.css, training.js, equipment.js, config, index, users at 03:17-03:18). I restarted the server mid-run; results below are for the tree as of 03:19.

## B1 technician (phone)
| Step | Guide says | Screen says | Corrected wording |
|---|---|---|---|
| 2.2 | "The app asks you to choose your own password" | Page "Choose a new password"; fields Current (temporary) password / New password / Repeat new password; button Save password | "Type the temporary password in the first box, then your own new password twice. Tap Save password." |
| 3 | (nothing about status) | Every starter record shows a Draft badge and 19 to 21 VERIFY | Add: "Records marked Draft or Needs Review are not approved yet. Treat every VERIFY value as unknown." |
| 4 | "[n] of [m] done" | "0 of 8 done. Your checklist is saved to your account." and "These steps are not approved yet. Confirm them against the manufacturer manual before relying on them." | matches; quote the real sentence |
| 5 | "tap the button" | Form fields: Type (Issue / Lesson learned), Title, Details, Related equipment (optional); button is Save | "Choose Issue or Lesson learned, type a Title, add Details if you like, pick the related equipment if it applies, tap Save." |
| 6 | "Offline, [n] changes waiting to sync" | "Offline — 1 change waiting to sync" (singular handled) ; after a refused change: "1 change needs attention" | quote exactly; add the "needs attention" state and that Sync lists it with Try again / Discard |
| 6 | quiz | Draft modules show the full quiz and Submit, but the server refuses: "This module has not been approved yet, so its quiz is not open. Ask your trainer." Offline the app first says "graded when you are back online", then the change lands under "needs attention" with that message | Add: "Quizzes only work on modules marked Approved." |
| 6/sign out | "Do not sign out while changes are waiting" | On the phone the name and Sign out are NOT in the header; Sign out is at the bottom of Account | "Sign out is at the bottom of the Account page." |
| general | "390x844" | emulation gives 390x664 | say "iPhone 14 emulation" |
No horizontal scroll on any phone page (0px). Checkbox rows 75px tall, radio rows 44px.

## B2 trainer (desktop)
| Step | Guide says | Screen says | Fix |
|---|---|---|---|
| 1 | "optionally link the equipment it is about" | New module form has ONLY Title, Level, Summary (buttons Create, Cancel). No equipment link anywhere | delete the equipment sentence; delete the "driven through the app's data call" caveat (now walked on screen) |
| 1 | banner "says it is not approved yet" | "Draft material — not approved yet." | quote |
| 2 | Add a question | works; section is collapsed; fields Question / Answers / Number of the correct answer; button Add question. Out-of-range number gives "correct_index out of range." | add: "The number must be between 1 and the number of answer lines." |
| 3 | Add a practical skill | field Skill, button Add skill | ok |
| 4 | videos | form: Where is the video? (SharePoint (recommended) / Link only / Upload a file (small clips only)), Title, Link, button Add video; hint "Share → Embed" | ok |
| 5 | Approve | module button is "Approve material"; equipment shows "Approve anyway (override)" plus "Override reason" when any VERIFY remains. First submission shows "This material changed or is waiting for review. It must be approved again." | warn: "On a first submission ignore the words 'approved again'." Name both buttons |
| 6 | list "includes ... other trainers" | the trainer's own name is no longer listed (BETTER); leader and technicians are. Scores are a dropdown "Score for <skill>": 0 — Not demonstrated, 1 — Needs coaching, 2 — Competent, minimal help, 3 — Independent; toast "Score saved." | quote the dropdown text |
| 7 | missing list | "Sign-off requirements are not met. Written: no quiz taken yet (80% needed). Practical: "X" is unscored, needs 2+." Success toast "Signed off." | quote |
Whole path (create, 2 questions, skill, submit, leader approve, technician quiz fail 50% then pass 100%, score 2, sign off, matrix) worked.

## B3 leader (desktop)
| Step | Guide says | Screen says | Fix |
|---|---|---|---|
| Day 1 | nothing about starter files | Starter import works: Admin > Backups, export and import > Choose an export file > "Check the file" (preview) > "Import now". 14 equipment + 18 modules arrive Draft. starter/README-curriculum.md says "Administration > Import content ... preview (dry run)" which is not what the screen says | add a step: "Import starter-equipment-templates.json, then starter-curriculum.json: Admin, Choose an export file, Check the file, Import now. Everything arrives Draft. Technicians cannot take any quiz until you approve the module." Fix the starter README names |
| People | Create an account | collapsed section; fields Username, Display name, Role; button Create; "Temporary password for tina: ... Shown once. Give it to them privately." | ok |
| Wizard | photo, confirm, optional search, review | steps 1 Photo (Take photo / Choose photo / typed text), 2 Confirm, 3 Research (Search official sources; Draft a description with AI), 4 Review with Save as draft / Save and submit for review. Next/Review buttons | name the two save buttons |
| Approve | "Approve (button on each record)" | no plain Approve while any VERIFY remains: "Approve anyway (override)" + "Override reason (required, at least 5 characters)" | say so |
| Lifelines | Unlock now / Reset two-step / Show | all exist with those names | ok |
Wizard step 3 and Account text still say "administrator" while guides say "team leader".

## Claims check: docs/REVIEW-ROUND2.md and README.md
FALSE or misleading:
1. REVIEW-ROUND2 line 3: "Reports are in docs/round2/reports/, docs/privacy-drafts/, docs/rollout/" for ten specialists: reports/ holds 6 files (A1, field-ops README, accessibility, fix-snippets, performance, release). No red-team, leader-strategy, AV-librarian or instructional-designer report exists in the repo.
2. REVIEW-ROUND2: the "Please check: <fields>." fix shows internal field keys ("Please check: prompt, options." for the quiz form whose labels are Question and Answers). API clients still get "Invalid input.".
3. REVIEW-ROUND2 "Applied" list is not all in commit dc4ac09 and the tree is dirty: stack-free toast, td/th wrapping, "Approved with VERIFY items" badge, quiz-needs-approved rule are uncommitted. A stray server/index.js.orig sits in the repo.
4. README roles line: "Roles: admin, trainer, technician, viewer stored in the users table" is stale (custom roles and permissions exist). README says accounts are created under "Users"; the screen says People.
5. README never mentions starter/, docs/rollout/ or REVIEW-ROUND2.md (omission, not false). starter/README-curriculum.md uses "Administration > Import content" (screen: Admin, Import a file / Check the file).
6. B1 header says verified at 390x844; the emulation gives 390x664.
TRUE (verified): starter counts (18 modules, 14 equipment, all Draft, SAMPLE-labelled); role-change confirm with Cancel restoring the old role; 17 indexes; migration 009; /api/admin/about; umask 077; request id; EADDRINUSE handler; doctor .env lint; --line-ctl; scroll-padding-top; per-page titles; sync chip named link; one toast at a time; not-built list matches.
