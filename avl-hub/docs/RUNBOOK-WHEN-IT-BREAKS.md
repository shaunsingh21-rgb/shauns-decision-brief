# When something breaks (draft addition for docs/DEPLOY.md section 8)

Each row was reproduced in a sandbox. "You will see" is the real text the CURRENT app (0.2.0) produces today; rows marked (patched) show the wording after `support-upgrade.patch`.

**First, always:** `docker compose exec app node scripts/doctor.js`, then `docker compose exec -T app node scripts/support-bundle.js --stdout > support.txt` (patched) and send `support.txt` to the developer. It contains no passwords, keys or personal details.

| You will see | What it means | What to do |
|---|---|---|
| Nobody can sign in; the screen says **"Something went wrong."** (patched: it ends with a reference such as `3fa9c1d2`) | Most often the disk is full (`SQLITE_FULL`) | `df -h`. Free space: delete old `before-restore-*` folders, lower `BACKUP_KEEP`, or ask IT. Then `docker compose restart app`. Search the log for the reference: `docker compose logs app \| grep 3fa9c1d2` |
| App will not start; log says **attempt to write a readonly database** (patched: "the app is not allowed to write there (file permissions)") | The data folder or `avl-hub.db` is owned by the wrong user | Docker: volume must belong to user 10001. systemd: `sudo chown -R avl:avl /opt/avl-hub/data` |
| App exits immediately; log says **"listening"** or nothing, container restarts every few seconds (today) / **"could not listen on port 3000: that port is already in use"** (patched) | Another program, or a second copy of the app, holds the port | `sudo ss -ltnp \| grep 3000`; stop it or change `PORT` |
| Crash with a long stack trace mentioning **MFA_ENCRYPTION_KEY must be exactly 64 hex characters** | Typo in the key in `.env` | Put back the original key from the password manager. A NEW key makes every enrolled authenticator unusable (people use recovery codes; admin resets them) |
| App runs but nobody enrolled in two-step can sign in: **"this server is missing its key"** | `MFA_ENCRYPTION_KEY` blank or lost | `doctor` says so (red). Restore the key; if lost, `reset-mfa` for each person |
| Site works but cookies are not Secure / no HTTPS lock behaviour; `doctor` warns "NODE_ENV is not production" | `.env` says `NODE_ENV=Production` (capital P) | Must be exactly `production`. (patched: the app logs a WARN at start) |
| "Too many requests" for the whole team | `TRUST_PROXY=true` (word) instead of `1` | Use `1`. (patched: `true` is accepted) |
| Lesson videos stop embedding after editing `.env` | `SHAREPOINT_HOSTS` has `https://` or a `# comment` on the same line; the app sends the browser an invalid header (`frame-src https://https://host`, proven); browsers then block the embeds (browser behaviour reasoned, not tested) | Host names only, e.g. `moody.sharepoint.com`, comment on its own line. (patched: both tolerated, `doctor` warns) |
| Photos 404, uploads say **"The upload could not be read"** | The uploads folder was deleted or the volume was swapped | Nothing in the log today. (patched: `/healthz` returns 503 "uploads folder cannot be written"). Restore the newest backup |
| Everything looks fine but changes vanish after a restart | The database file was moved/replaced while the app ran (the app keeps writing to the deleted file) | (patched: `/healthz` 503 "database file has disappeared"). Stop the app, restore from backup |
| `BACKUP FAILED: database or disk is full` | Disk full | As above. The failed attempt leaves no half backup (verified) |
| Backups "OK" but folder keeps the same old ones; newest backup looks days old | Server clock went backwards (dead battery, restored VM). Today the new backup is **deleted as the oldest** | (patched: nothing is pruned and the command exits 4 with "the server clock looks WRONG"). `timedatectl` and fix the date |
| `docker compose ps` shows the **backup** container healthy but no backups appear | Nightly failures only print `BACKUP-FAILED` into Docker logs | (compose-fixes: the container turns unhealthy after 36 h with no backup) |
| After an update the site misbehaves | A bad release | Do NOT just `git checkout` the old code over the new data: old code runs on the new database and skips two-step sign-in (proven). Roll back with: stop app, `git checkout <old>`, `restore.js <backup made before the update>`, start. (patched: a newer database makes older patched code refuse to start) |
| Browser shows **certificate** problems | Caddy cannot get a certificate (DNS/ports, or the clock is wrong) | `docker compose logs caddy`; check `date` on the server; ports 80 and 443 must reach Caddy |
