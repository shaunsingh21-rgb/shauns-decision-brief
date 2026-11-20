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
