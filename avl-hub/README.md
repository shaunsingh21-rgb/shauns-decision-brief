# AVL Tech Training & Equipment Hub

A shared, installable web app for the ITS Events AV team: equipment library with sourced specs, five-level training with quizzes and trainer sign-off, installation assistant, update tracking, issues and lessons, photo panels, lesson videos, skill matrix — usable offline.

| Read this | If you are |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | the team leader putting it on a server (plain language) |
| [`docs/BACKUP.md`](docs/BACKUP.md) | restoring, practising a restore, or in an emergency |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | reviewing what was decided, the limits, and the open questions |
| [`docs/PLAN.md`](docs/PLAN.md) | curious about the original Phase 1 plan (DECISIONS.md supersedes it where they differ) |

## Everyday commands
    npm install
    npm run create-admin -- yourname "Your Name"   # one time; hidden password prompt; refuses if an admin exists
    npm start                                       # http://localhost:3000
    npm run doctor                                  # plain-language health check
    npm run backup  /  npm run restore -- <folder>  # see docs/BACKUP.md
    npm run reset-password -- <username>            # emergency, server access only
    npm test  /  npm run test:e2e  /  npm run test:all

---
## Developer notes
Phases 2–3 of `docs/PLAN.md`: backend plus the web front end (vanilla ES modules, no build step).

    npm install
    npm run migrate                                   # creates data/avl-hub.db
    npm run create-admin -- shaun "Shaun Singh"       # one time; prompts for a password, refuses if an admin exists
    npm start                                         # http://localhost:3000   (PORT, DB_PATH, see server/config.js)
    npm test            # API + static checks (fast)
    npm run test:e2e    # real Chromium: login, wizard with OCR, training, mobile/dark mode
    npm run test:all

Roles: admin (Leader/Admin), trainer, technician, viewer — stored in the `users` table.
Every route declares its access in code (`server/api.js`); tests prove all mutating routes refuse other roles.
Accounts are created by an admin only (Users). Sign-in is local username + password; SSO extension point: `server/auth/oidc.stub.js`.
All demo content is labelled SAMPLE. Secrets (BRAVE_API_KEY, ANTHROPIC_API_KEY) are env vars only.

`npm install` also copies the OCR engine into `public/vendor/ocr` (served from our own origin; git-ignored). If that fails, the wizard falls back to typing the label text.
Brave search and AI drafting need `BRAVE_API_KEY` / `ANTHROPIC_API_KEY` in the server environment; without them those wizard steps show a clear "not configured" message and can be skipped.

## Files and lesson videos (Phase 4)
Uploaded files live on disk under `UPLOAD_DIR` (default `data/uploads`), never in the database; SQLite keeps metadata only. Type is decided from the file's own bytes.
Limits (env): `MAX_PHOTO_MB` 10, `MAX_DOC_MB` 20, `MAX_VIDEO_MB` 200. Photos: JPEG/PNG/WebP. Documents: PDF. Videos: MP4/WebM. Downloads need sign-in.
Lesson videos stay in SharePoint by default. Set `SHAREPOINT_HOSTS=yourtenant.sharepoint.com` to pin embeds (and the CSP) to your tenant; unset allows any `*.sharepoint.com`.
Back up `data/` (database **and** uploads) together.

## Offline and sync (Phase 5)
Install: iPhone Safari → Share → Add to Home Screen; Mac Safari → File → Add to Dock; Chrome/Edge → Install. HTTPS is required (localhost is exempt for testing).
The service worker (`/sw.js`, generated at start-up from the real files) caches the app shell. Data you have viewed is kept in this browser's IndexedDB and refreshed in the background.
Changes made offline wait in a queue and sync in order. Status is always visible: "All changes saved" / "N changes waiting to sync" / "Offline — showing saved data".
- Conflicts: last-writer-wins **per record**, decided by when the edit was *made* (device clock corrected to the server's), clamped so a wrong clock can't win. The overridden edit is reported to the person and audited.
- Sign-offs, approvals, quiz attempts, scores: append-only events, attributed by the server to the signed-in user; refused ones stay visible under Sync ("needs attention").
- Approvals apply to the version reviewed; if the record changed since, the server refuses (`STALE_REVIEW`).
- Needs a connection: uploads, research, AI drafting, admin actions. Quizzes are graded when you reconnect.
- Offline data lives on the device. Signing out clears it (and warns if changes haven't synced).
