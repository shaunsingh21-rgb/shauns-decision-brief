# AVL Tech Training & Equipment Hub

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
