# Round 2: ten specialist reviewers (domain, compliance, operations, product, verification)

Reports kept in the repo: `docs/round2/reports/` (wording audit, accessibility, performance, release, field-ops notes, guide test), `docs/privacy-drafts/`, `docs/rollout/`. The other round-2 reports (red team, leader, librarian, instructional designer) were summarised in the chat only. Everything below says what was **applied in code**, what is **supplied as files**, and what is **not built** (needs a decision).

## Applied in code (each has a test; `test/api/round2.test.js`, one browser test in `test/e2e/review-fixes.test.js`)
| Finding | Fix |
|---|---|
| Lockout counter never decayed (20 typo-then-right rounds locked an admin) | `succeed()` clears the all-addresses counter; idle counters fade after one lock period |
| One noisy address could lock an account for everyone | an address already over its limit no longer raises the all-addresses counter; IPv6 is counted per /64 |
| Credentials stored for replay when the URL's case changed (`/API/users`) | match is case-insensitive; migration 009 deletes rows already stored |
| `?purpose=constructor` hung the upload route | own-property check |
| Mistyped passwords written to the audit log | a typed name that is not an account is never recorded |
| Audit log showed trainer notes and scores to `audit.view` only | hidden unless the caller has `progress.view_all` |
| Equal-power role could drop someone's two-step requirement | only a Leader/Admin may move someone out of such a role |
| Database/uploads world-readable | `umask 077` at start-up |
| Role dropdown saved on one arrow key | asks first; Cancel restores the old role |
| Sync chip had no accessible name | named link plus a separate hidden live region (hidden text is clipped and ignores clicks: it once covered the Account link on a phone) |
| Form borders 1.38:1 | controls use `--line-ctl` (about 3.9:1) |
| "Invalid input." | rejected forms say `Please check: <fields>.` |
| Sign-in pages shared one title | each has its own |
| 400% zoom hid focused items | `scroll-padding-top`; header not pinned on short windows |
| Release engineering patch | refuse a newer database, port-in-use exits 1, deep `/healthz`, `GET /api/admin/about`, request ids + rotating log, `npm run support-bundle`, backup clock guard, `.env` lint, migration race |
| Performance | separate read budget (`API_READ_RATE_MAX`) so the start-up prefetch is not refused; at most 2 password checks at once; 17 indexes (migration 008); batched progress; upload time limit lifted; |

## Supplied as files (import them yourself)
`starter/starter-curriculum.json` (18 draft modules) and `starter/starter-equipment-templates.json` (14 draft records). Admin → import. Everything arrives as **Draft** and labelled SAMPLE. A trainer must review every question; the correct answer is often the longest option.

## Not built (your decision)
Overview/records/readiness/re-certification (mock-ups in `docs/round2/mockups`), search + QR labels + bottom bar (`docs/round2/field-ops-prototype.patch`), per-unit records, module prerequisites, required coaching note for scores below 2, person anonymise + retention job, captions for uploaded videos, snapshot endpoint for the offline prefetch, hard-linked backups, the wording changes in `docs/round2/reports/A1-wording-audit.md`, remaining accessibility items (focus after re-render, pin names, field-level `aria-invalid`).

## Honest limits
No real iPhone/Safari, no real hosting or Docker daemon, no screen reader. Round-2 agents measured on shared CPUs. One fix (a noisy address locking out everyone) has a test that also passes on the old code, so it is not proven by a test.

## Round 3 (same ten roles re-tested the fixed app; desktop and an emulated iPhone 14 in Chromium, NOT real Safari)
Result: the fixes held (every round-2 security repro was fixed or partly fixed; 1..9 schema upgrades, interrupted migrations and two-instance starts are safe). They also introduced problems, now fixed:
- a misplaced line threw a ReferenceError on every 500 and the long-upload timeout never applied: moved after `listen`;
- reads and writes shared one rate counter, so a big prefetch could block queued writes: now separate counters;
- the audit scrub missed `practical.score` and `quiz.attempt`: fixed and tested;
- quizzes could be taken on Draft modules: refused (409) and the screen says the quiz opens on approval;
- a 429 or 5xx on `/api/me` sent a signed-in person to the login page: only a 401 does now;
- the specs table wrapped letter by letter on a phone (`overflow-wrap:anywhere`): fixed;
- an override-approved record showed a plain green Approved badge: now "Approved with VERIFY items";
- toasts stacked: one at a time; "1 one is still blank": fixed;
- the sign-in queue was unbounded: capped at 20 waiting (then 503); backup folders dated in the future no longer stop pruning or hide a missing backup; 404 floods no longer fill the log; `TRUST_PROXY=false/no/off` means off; a non-numeric setting falls back to its default with a warning.
Tried and reverted: wiping saved data on a 401 also erased unsynced offline work. The browser keeps the cache after the server ends a session: still open.

Still open from round 3: starter quiz questions (the right answer is the longest option in 81 of 90: do NOT use the starter quiz as evidence for sign-off until a trainer rewrites it); approving unreviewed SAMPLE content takes one click; 20 addresses with one failure each can still lock an account (needs a spoofable proxy header or 20 real addresses); `support.scrub` misses some secret forms; `audit_log.ip` and EXIF are kept; server messages and the three quick-start guides still need the wording fixes in `docs/round2/reports/R3-guide-test-and-claims.md`; Docker files are the originals.
