# r2-release-support: evidence log (release engineer + support engineer)

All scripts are in this folder and re-runnable: `node upgrade-matrix.js` (set `AVL_ROOT=<repo copy>` to test patched code).

## 1. Upgrade proof (current code, repo untouched)
* `fixture.js` builds a database at every schema version (first N migration files via `migrate(db, dir)`), filled with: 9-10 users in all 4 roles + disabled + custom role (v5+), 5 sessions, lockout row, source domain, 6 equipment with fields and approvals, 3 modules with quizzes/attempts/practical scores/sign-offs, issues, update records, 25 audit rows, install steps/progress (v2+), 3 uploaded files with bytes on disk, lesson videos, checkpoints, panel + 4 pins + approval (v3+), idempotency rows (v4+), MFA enrolment + recovery code + challenge (v6+), a versioned sign-off (v7), real argon2id hashes.
* `upgrade-matrix.js`: for N = 1..7: current `migrate` -> row-by-row comparison of every pre-existing row (not just counts), `foreign_key_check`, `integrity_check`, append-only triggers still present, edit_at backfilled, the CURRENT server started on it as a child process, old password signs in (wrong one refused), 3 old sign-offs show and are not "stale", old upload served byte-for-byte (v3+), custom-role user signs in (v5+), backup of the upgraded DB verifies, an OLD-version backup restores into the current schema with files. **90 checks, 0 failures** (current code AND patched code).
* Interrupted migration (`interrupted.js`): SIGKILL inside the open transaction (deterministic, after 005/006/007 SQL has run, before commit) plus 150,000-user / 100,000-sign-off databases killed by a second process at 120-300 ms (the migration is synchronous, so only another process can kill it). 10 real kills: every database was `integrity_check ok`, no `users_new`/`signoffs_new` left behind, re-run completes, row counts identical. Result: **safe**.
* Two instances: started two real servers at once on v1 and v5 databases, 3 trials each: no failures (timing too tight to collide). Forced race (`race.js`: both read the applied list, then wait for a barrier): **the loser crashes** with `table install_steps already exists` / `table roles already exists` / `duplicate column name: quiz_hash`; data intact; a supervisor restart fixes it. Patched (BEGIN IMMEDIATE + re-check): both succeed.
* **Downgrade (`downgrade.js`, `downgrade2.js`)**: code from commit c5a13ea (before roles/MFA) was started on a current (v7) database. It starts, serves 200, and **does not refuse**. With a role set to `require_mfa` and an admin enrolled in two-step, the old code issues a session on **password alone** (current code correctly returns `mfa_required`). Custom-role users are treated as unknown roles. Data was not corrupted (integrity ok, row counts equal) but the security rule silently vanished. Fix: refuse a database containing migrations the code does not know (in the patch; protects from the NEXT release on, so it must ship now).

## 2. Break-it results (current app 0.2.0)
| Scenario | Admin sees today | Docs help? |
|---|---|---|
| Port in use | Prints "AVL Hub listening on :4430" and **exits with code 0** (Express 5 passes the listen error to the callback; the code ignores it). systemd `Restart=on-failure` does NOT restart exit 0: service silently dead. Docker restarts forever, logging "listening" each time | No |
| `PORT=abc` | Raw `ERR_SOCKET_BAD_PORT` stack | No |
| `NODE_ENV=Production` | Starts as non-production silently (no Secure cookies, no HSTS, no `__Host-`). Only `doctor` warns | Partly (doctor) |
| `TRUST_PROXY=true` | Treated as unset (NaN); startup WARN says "not set" (misleading) | No |
| `SHAREPOINT_HOSTS=https://x.sharepoint.com` or `host # comment` | Accepted; CSP header becomes `frame-src https://https://x...` / `...host # our tenant`; doctor shows it as "limited to" with no warning | No |
| `export KEY=v` in .env | Line silently ignored (regex needs `KEY=`) | No |
| MFA key wrong length | Crash with stack trace (message readable at top of it) | Yes (DEPLOY 3.2) |
| MFA key missing | Enrolled users get a clear message; `doctor` red | Yes |
| DB file not writable | Crash: `SqliteError: attempt to write a readonly database` from `sessions.js purgeExpired` (cause not stated). `doctor`: `EACCES ... access '/data'` | No |
| Disk full | Every sign-in: "Something went wrong." (500); log has `SQLITE_FULL` stack, no request id/path. Upload fails the same way. Backup: clean `BACKUP FAILED: database or disk is full`, exit 1, no partial folder. `doctor`: "0.0 GB free" | BACKUP.md covers backup only |
| Uploads folder deleted while running | Upload: "The upload could not be read." (wrong cause); old files 404; `/healthz` still `{"ok":true}`; nothing logged | No |
| DB file moved while running | `/healthz` `{"ok":true}`, API still works (writes go to the unlinked file and are lost at restart) | No |
| Backup truncated / bit-flipped / manifest deleted | Restore refuses with plain messages (checksum / incomplete) | Yes |
| Uploaded file bytes altered or deleted after backup | `verifyBackup` checks only the file COUNT, not content (reasoned from code) | n/a |
| Clock goes backwards | Folder names are timestamps and prune deletes the lowest names: the **new backup is the one deleted** (3 of 3 trials; the backup script then reports a failed verification). Doctor/backup-status judge by name too | No |
| Backup silently failing for a week | Compose loop prints `BACKUP-FAILED` into Docker logs only; container stays "healthy"; Admin screen shows an age but nobody pushes it; systemd timer: only `systemctl --failed` | Partly (doctor, Admin age) |
| App crash loop | Docker `unless-stopped` and systemd `Restart=on-failure RestartSec=5` (5 restarts take 25 s, never reaching the default start limit of 5 in 10 s) loop forever; nothing alerts; HEALTHCHECK marks unhealthy but nothing acts on it | No |
| Expired certificate (not testable) | Caddy renews automatically from 30 days before expiry; failure modes are DNS/port 80 closed or wrong server clock. Browser shows a full-page warning; the app cannot know. Nothing in docs explains where to look except `docker compose logs caddy` | Partly |

## 3. Logging and version review (current)
No request log, no request ids, no startup banner (only "listening on :port"), `/healthz` is the constant `{ok:true}` (never touches the DB), no version anywhere (package.json says 0.2.0 but no endpoint, no log line, no commit), 500s log a bare stack with no path/user/request id, no rotation (Docker json-file has no size cap by default; Caddy logs nothing by default), no support bundle.

## 4. Static review of Dockerfile / compose / systemd / Caddyfile / DEPLOY.md
`docker compose config` ran (docker CLI exists, no daemon): valid when `.env` exists with DOMAIN; without `.env` the error is "env file .../.env not found" (DEPLOY's table only mentions the DOMAIN error). Image build and run could NOT be tested.
Would fail or surprise on a real server:
1. `./offsite` bind mount: Docker creates it root:root 755; the backup container runs as uid 10001, so `BACKUP_COPY_TO=/offsite` fails every night with exit 3 (reasoned; fix = `mkdir offsite && sudo chown 10001 offsite` in DEPLOY, or a named volume).
2. Backup time "02:15 server time" is 02:15 UTC inside the container (no TZ, base image has no tzdata) = evening in Chicago. Fixed in `compose/` (TZ + tzdata).
3. No log rotation for Docker logs (fixed in `compose/docker-compose.fixed.yml`).
4. `caddy depends_on: [app]` does not wait for health (fixed: `condition: service_healthy`).
5. No UDP 443 (HTTP/3) published: harmless. No Caddy access log: add `log` if wanted.
6. systemd: `.env` copied with mode 644 while holding keys (no `chmod 600` in DEPLOY; doctor now warns). Unit has no `OnFailure=` for the backup service. `EnvironmentFile` does not understand `export` or inline comments either.
7. `docker compose up -d --build` builds the same Dockerfile for `app` and `backup`: fine. Rollback advice missing (see downgrade).
8. DEPLOY 3.1 `git clone` requires access to a private repo from the server; not mentioned.
9. README/DEPLOY honest note says the image was never built: unchanged risk. A CI job that runs `docker build` + `docker compose config` would remove it.

## 5. Prototype (tested; `support-upgrade.patch`, applies cleanly with `patch -p1` in `avl-hub/`)
Files: `server/lib/support.js` (new), `server/routes/support.js` (new), `scripts/support-bundle.js` (new), edits to `server/db.js`, `server/config.js`, `server/index.js`, `scripts/doctor.js`, `scripts/backup.js`, `scripts/lib/backup.js`, `package.json`.
Tested: 90/90 upgrade checks; 10/10 interrupted-migration kills; forced race now passes; existing repo tests `backup`, `hardening`, `review-fixes`, `static`, `portability`, `roles` plus `mfa` all pass, after fixing one bug in my first draft that the SIGTERM test caught; `/healthz` returns 503 for uploads removed, DB moved, DB replaced, disk full, schema newer; banner, request log with `X-Request-Id`, port-in-use exit 1, PORT/MFA/newer-schema/permission failures print one FATAL line + WHAT TO DO (stack goes to `data/logs/avl.log` only); support bundle leaked 0 of 5 planted secrets (key, `sk-ant-`, password=, cookie, 32+ hex) while linting a deliberately broken `.env` (7 problems found).
Not covered by the prototype: front-end "About" box, `scripts/restore.js` note on clock, per-file checksums in the backup manifest, alert delivery (email/Teams) for failures.
