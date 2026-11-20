# Decisions, trade-offs and open questions

Written at the end of Phase 6. "Decided by you" items came from the brief and were not revisited. "Decided by me" items are my judgement calls — **please read those and tell me which to change**; each says what it costs to change.

## A. Decided by you (not revisited)
1. **Web app hardened as an installable PWA** (iPhone: Add to Home Screen, Mac: Add to Dock) behind HTTPS, with a shared backend. No native iOS/macOS app, no Capacitor/Tauri.
2. **Accounts are created by the admin only.** No self-sign-up. Local username + password; argon2id; server-side sessions in Secure/HttpOnly/SameSite cookies; sign-in rate limiting and lockout; admin-initiated reset; forced change at first sign-in.
3. **Auth sits behind an interface so SSO can replace it** without touching anything else. SSO is *not* built. The extension point is `server/auth/oidc.stub.js`; `users.auth_provider` and `users.external_subject` exist. To add Entra ID: implement `authenticate()` for the OIDC callback, look users up by `(auth_provider, external_subject)`, only for accounts an admin already created, set `AUTH_PROVIDER=oidc`.
4. **Conflict rule:** last-writer-wins per record; sign-offs and approvals append-only and attributed to the signed-in user.
5. **Rules carried over:** sign-off needs quiz ≥ 80% and every practical skill ≥ 2, never your own; editing approved material returns it to Needs Review; approving with VERIFY items needs an explicit override; written and practical progress tracked separately; official sources only from admin-listed domains; AI output always labelled, never auto-approved; Brave and Anthropic only on the server; strict CSP; import/restore validated and must leave an administrator; 44px targets, safe areas, camera capture, keyboard pin placement, labels, dark mode, reduced motion.

## B. Decided by me — please review
**There was no prototype to copy**, so the data model, rules wording and screens were drafted from the brief. Treat everything below, and all on-screen wording (provenance names, rubric labels, status names), as a proposal.

| # | Decision | Why | Cost to change |
|---|---|---|---|
| 1 | **SQLite**, not Postgres | One team, one server; backup is one file; zero admin. | Moderate. Revisit if you need several app servers or hundreds of simultaneous users. |
| 2 | **Access is declared on every route** and a test proves each mutating route refuses every role not listed | Makes "permission checks on every mutating endpoint" checkable, not a promise. | Low. |
| 3 | **Only Leader/Admin approves** (equipment, modules, panels). Trainers/technicians *submit for review*. | Approval is the control that stops unreviewed (or AI-drafted) content from being trusted. | Low: change one role list per route. |
| 4 | **Trainers can't score their own practicals**, as well as not signing themselves off | Otherwise self-sign-off is one step away. | Low. |
| 5 | **Sign-off does not require the module to be Approved** | Not in your rules. | **Open question** — see §F. |
| 6 | **Quiz answers never reach learners**; grading is on the server | Otherwise answers are readable in the browser. | Consequence: quizzes can't be graded offline; answers queue and are scored on reconnect. |
| 7 | **Provenance on every value**: Manufacturer / Team / AI-drafted / VERIFY. VERIFY = no value. Manufacturer requires a source on an admin-listed domain (subdomains ok; lookalikes like `maker.com.evil.org` fail). | "Never guess specs" enforced by the database, not just the UI. | Low. |
| 8 | **Web research returns snippets; a person types the value.** Nothing is auto-extracted into a spec. | Extracting specs automatically is guessing with extra steps. | — |
| 9 | **AI drafts only rewrite text you confirmed**, are labelled, listed with what the AI could *not* find (becomes VERIFY), 30/hour/user | Limits invention and cost. | Low. |
| 10 | **OCR runs on the phone (Tesseract, vendored)** | The photo never leaves the device; no third-party script (CSP). Costs a `'wasm-unsafe-eval'` CSP allowance — the *only* relaxation (no inline script/style, no eval). | Removing OCR removes the allowance. |
| 11 | **UI is built with text nodes only** (no HTML strings); a test bans `innerHTML`, `eval`, inline styles, and checks index.html | Output escaping by construction. | — |
| 12 | **CSRF:** SameSite=Lax + a required custom header | Cheap, robust for a same-origin JSON app. | — |
| 13 | **Sessions:** random id, only its hash stored; 12 h sliding; lockout 5 failures / 15 min **keyed by username (unknown names too)**; per-device sign-in limit; same message for wrong user/password | No account enumeration; limits guessing. | Tunable by env vars. |
| 14 | **Temporary passwords are shown once** to the admin and never stored in clear or in the audit log | — | — |
| 15 | **Files on disk, not in the database**; type decided from the file's bytes; size limits per type; downloads need sign-in, are `nosniff` and sandboxed; PDFs download rather than open | Stops renamed executables/HTML; keeps the database small. | — |
| 16 | **Photos are re-encoded in the browser before upload** (drops EXIF/GPS) | Phone photos carry location. The *server* can't strip it, so a non-browser client could upload one with EXIF. | Add server-side image processing if that matters. |
| 17 | **Lesson videos: SharePoint by default**; uploaded files allowed but discouraged; link-only allowed | As you asked. **Checkpoints can pause only uploaded videos** — a cross-origin SharePoint player can't be controlled. For SharePoint/link videos checkpoints are a list to answer while watching. | Inherent to iframes. |
| 18 | **Offline:** service worker caches the app shell; data you've seen is cached in IndexedDB and refreshed in the background; changes queue | — | — |
| 19 | **Last-writer-wins is decided by when the edit was made** (device clock corrected to the server's, clamped to the last 90 days and never the future), not when it arrived | An edit made offline at 10:00 shouldn't beat an online edit made at 11:00 just because it synced later. Clamping stops a wrong clock from winning forever. The overridden edit is shown to the person and audited. | Per-*record*, so two people changing different fields of one record: the later whole edit wins. Per-field merge is possible later. |
| 20 | **Queued changes are idempotent** (unique key per change; the server remembers keys 30 days) | A lost response or retry never doubles anything. | — |
| 21 | **Offline approvals carry the version reviewed**; if the record changed since, the server refuses | Otherwise you could approve content you never saw. | — |
| 22 | **A rejected queued change stays visible** ("needs attention") until the person retries or discards it | Never silently drop a sign-off. | — |
| 23 | **Sign-out clears local data** and warns about unsynced changes | Shared devices. | — |
| 24 | **Import only adds** (never overwrites/deletes); content only; everything arrives as Draft; whole file validated first; can't create accounts; can't remove the last admin | Sign-offs and approvals are append-only history that points at content — replacing content would break it. | Replace-mode would need history to be exported too. |
| 25 | **Backup = folder** (online SQLite copy + files + checksums), verified after writing, 14 kept; **restore** validates first, refuses no-admin / newer / damaged backups, moves current data aside and rolls back on failure | Restores are where people lose data. | — |
| 26 | **Deployment:** Docker Compose + Caddy (automatic HTTPS), with a systemd alternative | Smallest thing a non-developer can run. **Docker image not built or run** here (no engine). | Low. |
| 27 | **`reset-password` command** needing server access | Lifeline if every admin is locked out. | — |

## C. Considered and rejected
Native app / Capacitor (decided); Postgres (not justified); self-sign-up; per-field merge or CRDTs (complexity beyond the rule you chose); auto-installing updates (never); importing approvals or "installed" states (would forge attribution); client-side API keys; hard-deleting panels/approvals (append-only history); editing a record's `created_by` on import.

## D. Known limitations and risks
* **iPhone offline storage:** iOS may clear a web app's local data if unused for weeks. Reopen online regularly. Not tested on a real iPhone.
* **Data on the device:** offline copies are readable by anyone who can unlock that device (until sign-out). Use device passcodes.
* **No email, no MFA.** Resets are admin-initiated. MFA is better delivered by SSO later.
* **The audit log lives in the same database** as the data. It is append-only to the app, but someone with server access could edit the file. Off-server backups and (if needed) forwarding logs to ITS's logging are the next step.
* **Single server:** SQLite allows one writer; fine for a team, not for many app servers.
* **Real services untested:** Brave and Anthropic tested with stand-ins; SharePoint with a sample address.
* **Accessibility:** automated checks (labels, targets, keyboard pin placement, announcements) pass; no manual screen-reader pass yet.
* **Self-service data export** is content-only (by design); backups are the full copy.

## E. Revisit when…
More than a few dozen people use it at once or you want more than one server → Postgres. ITS wants Microsoft sign-in → build the OIDC provider (§A3). Conflicts feel unfair in practice → per-field merge. You need proof of record integrity beyond the audit log → hash-chained or externally forwarded audit.

## F. Open questions for you
1. **Hosting target, domain, and where off-server backups go** (blocking deployment).
2. Should **sign-off require the module to be Approved**? (I recommend yes; it's one line.)
3. Who besides Leader/Admin, if anyone, may **approve**?
4. **Wording:** rubric labels (0 Not demonstrated … 3 Independent), provenance names, status names — change to your team's language?
5. Starting list of **official source domains**, and your **SharePoint host** (`SHAREPOINT_HOSTS`).
6. **Privacy:** accounts and training records are personal data — does ITS/HR need a retention period or approval? (Audit log currently kept forever.)
7. Do you want **MFA** before SSO exists?

## G. How this was verified
Automated tests run on every change (`npm run test:all`): API and security (roles on every route, lockout, rate limits, sign-off rules, provenance, files, sync/conflict rules, import, backup/restore, production headers and cookies, secrets scan, static output-escaping checks) and real-browser tests (login, wizard with real OCR, training, keyboard pin placement, video checkpoints, mobile targets, dark mode, offline opening, offline edits, two-client conflicts, sign-off queueing, sign-out wipe). Several guards were also deliberately broken to confirm the tests catch them. See `DEPLOY.md` §9 for what was **not** tested.
