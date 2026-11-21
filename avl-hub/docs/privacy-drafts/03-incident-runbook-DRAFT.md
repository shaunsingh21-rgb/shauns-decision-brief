# AVL Tech Hub — incident-response runbook (DRAFT)

> **DRAFT for the institution's IT security office and counsel. Not legal advice.** Notification duties (state breach law, FERPA, institutional policy, contracts) are decided by the privacy office / counsel, not by this runbook: step 1 of every scenario is to **tell them early**. Commands are taken from this repo's scripts and `docs/DEPLOY.md`; "Docker" form shown first, without-Docker form in brackets. Run server commands on the server only.

**Always first:** (1) note the time and who reported; (2) do not delete anything; (3) tell [IT security office / incident desk] and the app owner; (4) decide who talks to affected people.

**Facts that shape every response** (from testing): sessions last 12 h idle / 14 d absolute; disabling a user, resetting their password or resetting their two-step **signs them out everywhere**; a disabled user cannot sign in (tested 401); the audit log records sign-ins, failed sign-ins and IPs and cannot be edited by the app; the browser keeps cached data after a session expires and only **Sign out** wipes it; there is **no built-in "sign out everyone" command** (gap, see proposal in 05).

## 1. A phone or laptop with the app is lost or stolen
1. Admin (or `users.manage`) opens **People**: **Disable** the person's account (signs them out on every device), or Reset password (also signs out).
2. Remember the device itself may still hold cached training data, issue text and, if the person was an admin, the **user list and audit log** (proven in IndexedDB). The server cannot wipe it. Ask the institution to use its device-management **remote wipe** [MDM], and note whether the device had a passcode.
3. Check **Admin → Audit log** for that username: look for sign-ins from unfamiliar IPs after the loss time.
4. If two-step was on, the device alone cannot sign in. If their role requires it, they re-enrol after the reset.
5. Re-enable with a new temporary password only after the person is verified in person or via the service desk.
6. Record: device, time of loss, passcode yes/no, data categories on device (use doc 02 section B), decision by privacy office.

## 2. A password is leaked or typed somewhere wrong
1. In-app: People → **Reset password** for that person (new temporary password shown once; they must change it; all sessions end; lockout cleared).
2. Server, if no admin can sign in: `docker compose run --rm app node scripts/reset-password.js <username>` [`node scripts/reset-password.js <username>`].
3. **Search the audit log for the password text.** Proven: a password typed in the *username* box is stored in `audit_log` (`actor_name` and `detail`) and cannot be removed by the app. Run on the server (read-only, replace `X`):
   `docker compose exec app node -e "const D=require('better-sqlite3');const d=new D(process.env.DB_PATH||'/data/avl-hub.db',{readonly:true});console.log(d.prepare(\"SELECT id,ts,ip FROM audit_log WHERE actor_name LIKE ? OR detail LIKE ?\").all('%X%','%X%'))"` (do not paste the real secret into chat or tickets).
   If found, treat as a policy question: the entry cannot be redacted without a maintenance change (proposal P1 in 05). Restrict `audit.view` to the minimum until then.
4. If it was an **administrator's** password: also check People for new accounts or role changes (`user.create`, `user.update`, `role.*` in the audit log) and the Admin → export entries (`export.content`).
5. Two-step reset if their phone is also involved: People → Reset two-step, or `docker compose run --rm app node scripts/reset-mfa.js <username>`.

## 3. Someone is guessing passwords
Lockout is automatic (5 tries per username+address, 20 per username overall, 15 minutes). Admin → People shows who is locked. Audit actions to look for: `auth.login_failed`, `auth.lockout`, `auth.login_blocked_locked`. An attacker can lock out a real user (by design); `Unlock` in People. Escalate if failures come from many addresses or successes follow failures (`auth.login` after `auth.lockout`).

## 4. The server or its data may be compromised
1. **Contain:** take the app off the network [`docker compose stop`] but **do not delete** the host or volumes. Preserve a forensic copy: `docker compose exec app node scripts/backup.js` before stopping if the host is trusted, otherwise image the disk per IT security.
2. **Assume exposed:** every table in doc 02 section A (names, usernames, argon2id hashes, training records, audit log with IPs), uploaded files, and `.env` (Brave/Anthropic API keys, `MFA_ENCRYPTION_KEY`). Authenticator secrets are encrypted with a key held in `.env`, so if `.env` was readable, assume secrets are readable too.
3. **Rotate:** Brave and Anthropic API keys in their consoles; `MFA_ENCRYPTION_KEY` (existing authenticator enrolments become unusable: everyone re-enrols; use Reset two-step); administrator passwords (`reset-password.js`); `SESSION` cookies: restore a clean build, then end every session. There is no script for that today; on a clean server with the app stopped: `docker compose run --rm app node -e "const D=require('better-sqlite3');new D('/data/avl-hub.db').prepare('DELETE FROM sessions').run()"`.
4. **Rebuild** from a known-good image; **restore** only a backup taken before the compromise: `docker compose stop app`, then `docker compose run --rm app node scripts/restore.js /data/backups/<avl-backup-folder>` (restore refuses a damaged backup or one with no administrator, and keeps the current data in `before-restore-<date>`). Verify: `docker compose exec app node scripts/doctor.js`.
5. **Check integrity:** the audit log lives in the same file as the data (DECISIONS §D), so an attacker with file access could edit it. Compare with the oldest off-server copy in `BACKUP_COPY_TO`; compare row counts and last ids.
6. **Notify:** hand counsel/privacy office the list from doc 02 and the number of accounts (`doctor` shows accounts; the backup manifest records users and file counts). They decide on notification to individuals, the state, and the institution's officials.
7. **Afterwards:** forced password change for everyone (reset each, or add a script: proposal 05-P6), post-incident review.

## 5. Wrong data was shared (e.g. a bad export, a photo with a person in it)
* Export is audited (`export.content`), content only, no accounts. Check who and when.
* Photo: remove from panel, then Delete file (bytes removed from disk; **file name and row remain, and backups keep the bytes until pruned**: tell the privacy office the backup retention, doc 04).

## 6. Evidence checklist
Time line; audit-log extract (ids, actor, action, IP); backup folder names and timestamps; `doctor` output; the list of tables/files affected (doc 02); who was told and when.
