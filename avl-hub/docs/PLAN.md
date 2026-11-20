> **Superseded in places.** This is the original Phase 1 plan. Where it differs from `DECISIONS.md` (for example the test tooling and the OCR/CSP details), `DECISIONS.md` is correct.

# AVL Tech Training & Equipment Hub — Phase 1 Plan

Status: PROPOSAL for review. No application code exists yet.
There was no prototype to copy, so the domain model and wording below are drafted
from the project brief. Section 3 is the part to review most carefully.

## 1. Stack (and why)
| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node 20+ LTS, Express | Small, well known, one process to run |
| Database | SQLite (WAL) via better-sqlite3, plain-SQL migrations | One team, one server. Backup is one file. Postgres is not justified at this size |
| Passwords | argon2id (`argon2` package) | As decided |
| Sessions | Server-side table, opaque random id, httpOnly + Secure + SameSite=Lax cookie | As decided |
| Auth layer | `server/auth/` exposes an `AuthProvider` interface (`authenticate`, `currentUser`, `logout`). `local` is implemented; `oidc` is a documented stub. `users.external_subject` + `users.auth_provider` columns exist now | SSO later without touching routes |
| Front end | Existing-style vanilla JS ES modules, no framework or build step | Simple for a team lead to host; strict CSP stays easy |
| PWA | Service worker (app shell cache), IndexedDB cache + sync queue | Offline open and sync |
| Files | Local disk `data/uploads`, served only through an authenticated endpoint, size and MIME allowlist | Lesson videos stay in SharePoint by default |
| External APIs | Brave Search and Anthropic called only from the server, keys from env | No keys in client |
| Tests | `node:test` + supertest-style HTTP for API; Playwright (preinstalled Chromium) for PWA/offline | Ports of smoke / media / pwa |
| Deploy | Docker Compose (app + Caddy for automatic HTTPS), or a plain systemd service | Pick after hosting answer |

## 2. Repo layout (`avl-hub/`)
```
server/  index.js, config.js, db.js, migrate.js, audit.js
         auth/{index,local,oidc.stub}.js   middleware/{session,rbac,rateLimit,csrf,validate}.js
         routes/{auth,users,equipment,training,signoffs,media,issues,updates,sources,ai,sync,admin}.js
         services/{ocr-extract,research,draft,files}.js
migrations/  001_init.sql ...
public/  index.html, manifest.webmanifest, sw.js, css/, js/{api,store,sync,ui,sanitize}.js, js/views/*
scripts/ create-admin.js, backup.sh, restore.sh
test/    api/*.test.js, e2e/pwa.test.js
docs/    PLAN.md, DECISIONS.md, DEPLOY.md, BACKUP.md
```
The existing root `index.html` (a decision-brief page) is unrelated and left untouched.

## 3. Domain model and rules (REVIEW THIS)
**Roles:** Leader/Admin, Trainer, Technician, Viewer. Role stored on `users`; every mutating route is wrapped in `requireRole(...)`. Viewer is read-only. Technician edits own progress, issues, and equipment drafts. Trainer additionally runs practicals and signs off. Leader/Admin additionally manages users, source domains, approvals, import/restore.

**Equipment record** — each field (`model`, `specs`, `ports`, `firmware`, ...) is stored with provenance: `manufacturer | team | ai | verify`. Unknown values are saved as `VERIFY` (empty), never guessed. Material has status `Draft | Needs Review | Approved`. Editing Approved material returns it to Needs Review. Approving with any VERIFY field left requires an explicit override flag plus a reason, which is audit-logged.

**Add Equipment wizard:** photo/label -> OCR (client-side Tesseract.js, or server later) -> user confirms text -> server research via Brave restricted to admin-listed official domains -> optional Anthropic draft, labeled "AI-drafted", never auto-approved -> review screen with per-field provenance.

**Training:** five levels per path. Each level has a quiz (pass >= 80%) and a practical rubric (per skill 0–3, all >= 2 to pass). Written and practical progress are stored and shown separately. Trainer sign-off needs both passed, creates an append-only sign-off row attributed to the signed-in trainer, and is refused when trainer == trainee.

**Other:** installation assistant (checklist steps per equipment), update management (records available firmware/software; status `Available | Scheduled | Installed-by-human`; never auto-installs), issues/lessons learned, skill matrix (users x skills from practical scores).

**Media (Phase 4):** lesson video as SharePoint embed, uploaded file, or link-only, with timed checkpoints; photo panels with sourced pins (each pin has a source and provenance), keyboard-placeable, plus "Quiz me".

**Security carried over by design:** id and URL validation, MIME allowlist, HTML escaping on output, CSP with no inline script, import/restore schema validation requiring >= 1 admin, full audit log table written server-side in the same transaction as the change.

## 4. Auth specifics
Admin creates users with a temporary password; `must_change_password=1` forces a change at first login. Login rate limit per IP and per username, with lockout (default 5 failures -> 15 min). Admin reset issues a new temporary password. First admin: `npm run create-admin` prompts for the password (or reads an env var) once; refuses if an admin already exists. No default password anywhere in code.

## 5. Offline and sync (Phase 5)
IndexedDB mirrors read data and holds an outbox of queued mutations. Each record carries `updated_at` + `version`; the server applies last-writer-wins per record. Sign-offs, approvals and audit entries are append-only: queued as events, applied in order, attributed to the authenticated session user (never a client-supplied name). UI shows "All changes saved" or "N changes waiting to sync".

## 6. Phases and checks
1. This plan. 2. Backend + auth + RBAC + audit + tests (403 matrix, lockout, no self-sign-off). 3. Front-end port and all feature screens. 4. Media and files. 5. Offline + sync + conflict and offline-open tests. 6. Rate limits, env-only secrets, backup/restore scripts, DEPLOY.md, DECISIONS.md.
Each phase ends with tests run and a 3–5 line honest summary.

## 7. Not testable by me
A real iPhone install and camera, your hosting and DNS/HTTPS, your SharePoint tenant, real Brave/Anthropic keys (I will test those paths with mocks). I will say so in each summary.

## 8. What I need from you
Blocking before deploy (not before local coding): hosting target, domain/hostname, backup destination.
Optional: SMTP details (only for emailed resets), starting list of official source domains.
Later: Brave and Anthropic API keys (as env vars on your server, never in chat or git); a SharePoint sample embed link to test with.

## 9. Installs I will run (Phase 2)
`npm install` of: express, better-sqlite3, argon2, express-rate-limit, helmet, zod, multer, and dev tools (playwright already present). Reason: server, DB, hashing, headers, validation, uploads. Nothing global.
