# AVL Tech Training & Equipment Hub

Backend (Phase 2 of `docs/PLAN.md`). The front end arrives in Phase 3.

    npm install
    npm run migrate                                   # creates data/avl-hub.db
    npm run create-admin -- shaun "Shaun Singh"       # one time; prompts for a password, refuses if an admin exists
    npm start                                         # http://localhost:3000   (PORT, DB_PATH, see server/config.js)
    npm test

Roles: admin (Leader/Admin), trainer, technician, viewer — stored in the `users` table.
Every route declares its access in code (`server/api.js`); tests prove all mutating routes refuse other roles.
Accounts are created by an admin only (Users). Sign-in is local username + password; SSO extension point: `server/auth/oidc.stub.js`.
All demo content is labelled SAMPLE. Secrets (BRAVE_API_KEY, ANTHROPIC_API_KEY) are env vars only.
