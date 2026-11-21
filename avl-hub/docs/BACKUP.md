# Backups and restoring

Everything the app knows lives in **one folder**: the database (accounts, equipment, training records, sign-offs, audit log) and the uploaded photos and PDFs. A *backup* is a complete, checked copy of that folder at one moment.

## 1. What a backup contains

A backup is a folder named like `avl-backup-20261120-021500` containing:

| File | What it is |
|---|---|
| `avl-hub.db` | the whole database, copied safely while the app is running |
| `files/` | every uploaded photo and PDF (lesson videos stay in SharePoint, so they are not here — back SharePoint up as you normally do) |
| `manifest.json` | when it was made, a checksum of the database, file count, number of accounts and administrators |

The whole folder is private to its owner (mode 700, files 600). You may also notice SQLite's `-wal` and `-shm` helper files next to the live database on the server; they are part of how it works and are never in a backup (the backup is already a clean, complete copy).

It **does contain people's account records and password hashes** (not passwords). Store it as carefully as the server itself.

**It does not contain `MFA_ENCRYPTION_KEY`** (if you use two-step sign-in), by design: the authenticator secrets in a backup are encrypted with that key, which lives only in `.env`. **Keep a copy of the key in your password manager.** After a restore onto a new server, put the same key back in `.env`. If you cannot, nobody can use authenticator codes — people can still use their recovery codes, and an administrator can reset them (Admin → Reset two-step, or `reset-mfa`).

## 2. How backups run

* **Nightly at 02:15** (server time), automatically — by the `backup` container with Docker, or by the `avl-hub-backup.timer` without Docker.
* After each backup the script **re-opens the copy, runs a database integrity check, and verifies the checksum**. A failed check makes the backup report `BACKUP FAILED` and exit with an error — it never silently keeps a bad copy.
* The newest **14** are kept (`BACKUP_KEEP` changes this). Only folders named `avl-backup-…` are ever removed.
* Make one right now, any time: `docker compose exec app node scripts/backup.js` (without Docker: `npm run backup`). Two backups in the same second are fine: the second takes the next free timestamp.
* **Admin → Backups, export and import** shows the age of the newest backup (green within 36 hours, a warning after that).
* Is it working? `docker compose exec app node scripts/doctor.js` prints the age of the newest backup. Without Docker the log is `backups/backup.log`.

### Get a copy off the server (important)
A backup on the same disk is lost if the disk is lost. Pick one:
1. Set `BACKUP_COPY_TO=/path/to/a/mounted/share` in `.env`. Each night's backup is copied there too. If that copy fails, the backup command ends with a warning and a non-zero code.
2. Ask IT to include the backup folder in their server backups.
3. By hand: `docker compose cp app:/data/backups ./backups-copy` then copy `backups-copy` somewhere safe.

## 3. Restoring — step by step

**When:** the server was lost, data was damaged, or an update went wrong. **Restoring replaces the current data with the backup's data.** Your current data is *not* deleted: it is moved to a folder called `before-restore-<date>` next to the database, and put back automatically if the restore fails part-way.

1. **Stop the app** so nothing is writing:
   * Docker: `docker compose stop app backup`
   * systemd: `sudo systemctl stop avl-hub`
2. **Choose the backup.** List them:
   * Docker: `docker compose run --rm --no-deps app node scripts/restore.js` (with no name it lists the backups it can see)
   * systemd: `cd /opt/avl-hub && sudo -u avl node scripts/restore.js`
3. **Restore it** (replace the folder name with the one you chose):
   * Docker: `docker compose run --rm --no-deps app node scripts/restore.js /data/backups/avl-backup-20261120-021500`
   * systemd: `sudo -u avl node scripts/restore.js backups/avl-backup-20261120-021500`

   It first **checks the backup** and tells you what it found (when it was made, how many accounts and uploaded files). Type `RESTORE` to continue. It refuses — and changes nothing — if the backup is:
   * damaged or modified (checksum does not match), or incomplete (a file is missing);
   * from a **newer** version of the app than the one installed;
   * **without any active administrator** (nobody could sign in afterwards);
   * while the app is **running**: the app writes a small signal file (`.avl-running`) next to the database every few seconds, and restore refuses if it is fresh, even when the restore is started from a different container. After a clean stop the signal is removed at once; after a crash or kill, wait about 20 seconds.
4. **Start the app:** `docker compose up -d` (systemd: `sudo systemctl start avl-hub`).
5. **Check:** sign in, open Equipment, open a photo panel, look at **Admin → Recent activity**. Run `doctor`.
6. **Tell the team** that changes made between the backup and the failure are gone — and that people with unsynced changes on their phones will have those sent to the server when they reopen the app (the server decides what applies; see "Offline and sync" in the README).
7. When you are sure all is well, `before-restore-<date>` can be deleted. Do not delete it sooner. (`doctor` does not look for it; it is just a folder beside the database.)

If an old backup comes from an older version of the app, the database is brought up to date automatically during the restore.

## 4. Practise once (please)

In the first month, on a spare computer or a second VM:
1. Install the app as in `DEPLOY.md` (no need for a real domain), **do not** create an administrator.
2. Copy a recent backup folder onto it.
3. `node scripts/restore.js <that folder>` and start the app.
4. Sign in with your real account. If your equipment, people and a photo are there, your backups work.

Write the date you did this at the top of your own notes. Repeat after any big change (new server, new hosting).

## 5. Content export / import (this is *not* a backup)

**Admin → export** downloads a JSON file of *content only*: equipment (with where each value came from), install steps, training modules and quizzes, link/SharePoint videos, issues and lessons, update records, photo-panel pins and the official source list. **Import** adds that content to another install.

* It **never** includes accounts, passwords, sign-offs, approvals, quiz results or photos.
* Import **only adds**: items that already exist (same id) are skipped, nothing is overwritten or deleted. Imported items always arrive as **Draft** (approvals are never imported), updates arrive as "available", and everything is attributed to the administrator who imported.
* The whole file is checked first (same rules as the app: sources, VERIFY items, links). If **any** problem is found, **nothing** is imported. "Dry run" shows what would happen without changing anything.
* An import can never remove the last administrator, and cannot create accounts.

## 6. Emergencies

| Situation | What to do |
|---|---|
| **Nobody can sign in as an administrator** (forgotten password, locked, disabled) | On the server: `docker compose run --rm app node scripts/reset-password.js <username>` (systemd: `sudo -u avl node scripts/reset-password.js <username>`). Sets a new temporary password, unlocks and re-enables the account, forces a change at next sign-in, and is written to the audit log. Needs access to the server, so it cannot be done from the website. |
| **Server destroyed** | New server → `DEPLOY.md` sections 2–3 (skip creating an administrator; use the **same** `MFA_ENCRYPTION_KEY` as before if you had one) → restore the newest off-server backup (section 3). |
| **Lost phone, no recovery codes** | Another administrator: Admin → **Reset two-step** next to their name. If it is the only administrator: on the server, `docker compose run --rm app node scripts/reset-mfa.js <username>` (without Docker: `sudo -u avl node scripts/reset-mfa.js <username>`). |
| **Someone deleted or broke content** | Restore a backup to a *spare* machine (section 4), copy what you need by hand (or use export from there and import here). |
| **Backup says `BACKUP FAILED`** | Read the message; the usual causes are a full disk or a wrong path. Fix it, run `backup` by hand, and check `doctor`. Until a backup succeeds, you have no new protection. |
| **Disk almost full** | `doctor` warns under 2 GB free. Delete old `before-restore-…` folders, lower `BACKUP_KEEP`, or ask IT for more disk. |
| **A backup folder looks odd or was edited** | Don't restore it: `restore` will say "does not match its checksum". Use an older one. |
