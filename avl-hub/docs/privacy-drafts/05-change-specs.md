# Proposed app changes (ranked), with designs

Evidence for every "proven" statement is in `EVIDENCE.md` and `prove.out`. Everything here is a proposal; the repo was not touched.

## P1. Stop writing credentials and free text into the permanent audit log (S, high)
**Proof:** a password typed in the username box was stored as `actor_name` and `detail.username` in `audit_log` (append-only, readable by every Audit holder, in every backup). Same for search queries and sign-off notes (copied from `signoffs.note`).
**Change** (`server/routes/auth.js` around line 49, `server/routes/training.js` 188–205, `external.js` research audit):
* On failed login: record `actor_name=null`, `detail={known:true|false, user_hash: sha256(lower(username)+pepper).slice(0,12)}`; only when the username matches an existing user record `entity_id=user.id`. A mistyped password is then never stored.
* Validate username shape before auditing (`^[A-Za-z0-9._-]{3,40}$` else `detail={invalid:true}`).
* `signoff.create`: audit `note_present:true`, not the text. `research.search`: `query_len`. Resolve names from ids at display time: stop storing `trainee` display name (`practical.score`, `signoff.create`): the audit view already resolves ids (`nameOf` in `users.js`). This is what makes P2 cheap.
* Redact existing rows once with the gated update in P2.

## P2. "Anonymise a departed person" that keeps append-only integrity (M, high)
**Proof:** there is no way to remove a person today: `DELETE /api/users/:id` is 404; direct DELETE fails on foreign keys; renaming leaves the **username**, and 9 audit rows (actor name, trainee name, notes) still name the person; `UPDATE audit_log`/`signoffs` are blocked by triggers.
**Design (migration `008_anonymise.sql` + `POST /api/users/:id/anonymise`, permission `users.manage`, Admin-only by default, refused for the last admin, for yourself, for anyone on hold):**
1. Keep the **user id** (all foreign keys, signer/trainee links, append-only rows stay valid).
2. In one transaction: `username='former-'||substr(id,1,8)`, `display_name='Former team member'`, `password_hash=NULL`, `external_subject=NULL`, `disabled=1`, add `users.anonymised_at`; delete `sessions`, `user_mfa`, `mfa_recovery_codes`, `mfa_challenges`, `idempotency`, `install_progress`; null `files.original_name` for their uploads (`'photo-<n>'`).
3. **Audit/sign-off text:** add table `maintenance_gate(open INTEGER)` (one row, 0). Replace the audit/signoff triggers with `... WHEN (SELECT open FROM maintenance_gate)=0 BEGIN SELECT RAISE(ABORT,...)`. The anonymise function opens the gate **inside its transaction**, rewrites only `actor_name`, `ip`, and removes name/note keys from `detail` (`json_remove`) for rows whose `actor_id`/`trainee_id` is that person, and (optional) `signoffs.note`, then closes the gate. Row ids, actions, timestamps, module versions, scores, signer ids stay: **integrity of the record of what happened is intact; only the identifying text is gone.** The gate is closed in all other code paths, and a test asserts `UPDATE audit_log` is still refused outside the function.
4. Write **one new audit row** `user.anonymise` (actor = the admin, entity_id = id, detail = counts) and one row to a **`deletion_ledger`** (`subject_id`, `at`, `by`). Restores re-run the ledger (script `scripts/reapply-ledger.js`, called by `restore.js`) so a restored backup does not resurrect a person.
5. UI: People → "Anonymise…" with a typed confirmation and a summary of what will be kept ("N sign-offs and M scores stay, under 'Former team member'").
6. If a hash-chained audit is added later (DECISIONS §E), chain over `(id, ts, action, entity, entity_id, actor_id)` and keep names outside the hashed fields.
**Tests:** after anonymise, `SELECT ... WHERE detail LIKE '%Tom%' OR actor_name='tom'` returns 0; sign-off still counts toward the matrix; triggers still refuse a normal UPDATE; restore + ledger removes the person again.

## P3. "Export everything about one person" subject-access package (M, high)
`GET /api/users/:id/data-package` (permission `users.manage` or `audit.view`+`progress.view_all`; own record also allowed at `/api/me/data-package`). JSON (and a readable HTML/markdown rendering) with: account fields (no hash), role, created/last sign-in; quiz attempts; practical scores received (with notes) and given; sign-offs received and given; checkpoint responses; install ticks; issues/updates/panels authored (ids and titles); approvals made; files uploaded (name, size, time, not bytes unless asked); **audit rows where actor_id = person or entity_id = person or detail.trainee_id = person** (includes IP); active sessions count; MFA enrolled yes/no (no secrets). Audit the export (`subject.export`). Excludes other people's data: for rows involving others show ids as "colleague". About 150 lines; all the queries already exist as column lookups listed in doc 02.

## P4. Configurable retention job (M, high)
Extend `ctx.maintain` (`server/index.js` line ~91; runs every 6 h) with env settings and a `retention_log` audit row each run:
`RETAIN_AUDIT_DAYS` (default 730), `RETAIN_AUDIT_SECURITY_DAYS` (1095), `RETAIN_IP_DAYS` (90: truncate/null via gated update), `RETAIN_IDEMPOTENCY_DAYS` (7), `RETAIN_QUIZ_ATTEMPT_DAYS` (365, keep best passing per user+module), `RETAIN_DEPARTED_DAYS` (365: auto-anonymise disabled accounts), `RETAIN_BACKUP_COPY_KEEP` (= `BACKUP_KEEP`). Defaults **off** (0 = keep) for the destructive ones until the institution chooses, with a Doctor warning "no retention set". Audit deletes need the maintenance gate from P2; use a *row-id range* delete so continuity is visible (`audit.retention` row records the id range removed). Honours a global `legal_hold` setting. Also fix `scripts/backup.js` so `BACKUP_COPY_TO` is pruned to the same `keep` (today it grows forever).

## P5. Wipe the device when the session ends, not only on Sign out (S, med–high)
**Proof:** Playwright: signed in as admin, browsed 6 screens: IndexedDB held **15 cache rows incl. `/users` and `/audit?limit=50`** plus the profile; Sign out → 0 rows (works). But when the server session was deleted (as at expiry or disable) and the page reloaded, the login screen appeared with **14 cache rows + profile still on disk**.
**Change:** in `public/js/app.js`/`http.js`, on a 401 from `/me` or any call (not offline), call `store.clearUser(lastKnownUserId)` and the service worker `clear-private` message; add a `cachedAt` TTL: ignore and delete cache rows older than 7 days at start-up; never cache `/users` and `/audit` (admin-only, sensitive: skip in the prefetch/`cachePut` list). Also add a "last wiped" line on the Account page.

## P6. Incident tooling: `scripts/revoke-sessions.js` (S, med)
There is no command to sign everybody out (runbook 4.3 uses a raw SQL one-liner). Add `node scripts/revoke-sessions.js [username]` (deletes from `sessions`, writes an audit row), and an Admin button "Sign out everyone". Optionally `scripts/force-password-reset.js --all`.

## P7. IP address handling (S, med)
Store IP only where needed: `sessions.ip` (needed to show "your devices" later) and audit rows for **security actions** (`auth.*`, `user.*`, `role.*`, `export.*`, `import.*`). For ordinary content edits (`equipment.*`, `issue.*`, `quiz.attempt`, `practical.score`) store `ip=NULL`. Truncate after `RETAIN_IP_DAYS`. Behind Caddy `TRUST_PROXY=1` the stored value is the real client address; a campus NAT/VPN makes IPs weak identifiers anyway. Document in the privacy notice.

## P8. Server-side EXIF stripping and a "no people in photos" prompt (S–M, med)
**Proof:** uploaded a JPEG with an EXIF block (a GPS-like string and an owner name) directly to `/api/files`; the downloaded bytes still contained it. Only the official web client re-encodes. Re-encode on the server (`sharp`, or strip APP1/APP13 markers in the JPEG byte stream) for `purpose=photo`; also replace `original_name` with a generated name (original names like `IMG_Tom_Home_Kitchen.jpg` are returned to everyone). Add a one-line hint on the upload screen.

## P9. Narrow what a Viewer / every user sees (S, low–med)
`/api/people` gives every signed-in user the full team list with roles (needed for pickers, so keep for roles that hold `training.score`, `training.signoff`, `progress.view_all`, `users.manage`); for others return only `id`+`display_name` or hide the screen. Do not return `created_by`/`updated_by` ids on `issues` to roles that cannot see people. Decision for the institution: is a team-wide name list acceptable to a read-only viewer who may not be on the team?

## P10. Privacy notice on screen + service statements (S)
Show `01-privacy-notice-DRAFT.md` text on the sign-in screen (link) and `#/account` ("Your data" card with the three actions: download my data (P3), what is stored on this device and "Wipe this device now", who to contact). A one-time "I have read this" is optional; record acceptance version in `users` if the institution requires it.

### Data-processing statements for the two outside services (confirmed from `server/routes/external.js`)
* **Brave Search:** server → `api.search.brave.com`, GET with the person's typed query plus `site:` terms for admin-listed domains and the API key header. No user id, name, IP, or cookies. Results are filtered to listed domains and returned as snippets; nothing saved except the query text in the audit log. **To confirm with Brave's current terms (VERIFY):** whether queries are logged, how long, and whether an enterprise/zero-retention option exists.
* **Anthropic:** server → `api.anthropic.com/v1/messages`, POST with up to 6,000 characters of text a person pasted, a fixed instruction, and the model name. No user id/name/IP/metadata. The reply is shown to the person and never auto-saved; only `purpose` is audited. **To confirm against the institution's agreement (VERIFY):** retention of API inputs and outputs, whether they are used for training, region, subprocessors, and whether the institution's data-classification policy allows student or employee personal data to be sent (the app's advice: it must not be).
* Both: calls are rate-limited per person (`AI_RATE_PER_HOUR`, default 30/h); keys are server-side only. Neither is called unless the key is set and the role holds `research.use`. An institution that prefers to avoid the transfer can leave both keys unset (the screens say "not set up").
* **Gap:** nothing stops a person pasting personal data into those boxes. Add a warning line above both inputs and a simple pattern check (email address, phone number, 9-digit/ID-looking strings) that asks "This looks like personal information. Send anyway?" (S).
