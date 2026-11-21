# Putting AVL Tech Hub on a server — a guide for the team leader

You do not need to be a programmer. You need about two hours, someone from IT for three small requests, and the ability to copy and paste commands. If a step does not match what you see, **stop and ask** — nothing here is urgent, and nothing is permanent until you tell the team to use it.

> **Honest note.** The app, the backups and the restore were tested thoroughly on a development machine, including a "production mode" run with a real browser. The Docker setup in this guide was **written carefully and its configuration file was checked, but the Docker image has not been built or run** (the machine this was developed on had no Docker engine). Expect that first `docker compose up` might need one small fix; the "If something goes wrong" table at the end covers the likely ones. Your hosting, your web address and your SharePoint were not available to test.

---

## 1. What you are setting up

* One small server (a "virtual machine") that runs the app 24/7.
* A web address for it, like `https://hub.yourorg.edu`. **It must be HTTPS** — iPhones will not install or run the app offline without it.
* Nightly automatic backups of all data.

Everyone on the team opens the web address, signs in, and (on phones/Macs) installs it like an app.

### What size of server?
Small. 2 CPU cores, 2 GB memory, 40 GB disk is plenty for a team. Linux (Ubuntu 22.04 or 24.04 is the easiest). Photos and videos are what use disk; videos should stay in SharePoint, as designed.

### Which hosting option?
| Option | Good for | Notes |
|---|---|---|
| **A. A Linux server from ITS (or any cloud) using Docker** | Most teams. **Recommended.** | Section 3. HTTPS certificates are automatic. |
| **B. A Linux server without Docker** | If ITS does not allow Docker | Section 4. Slightly more steps. |
| Windows PC / a Mac in a closet | Not recommended | It sleeps, reboots, loses power, and is hard to back up. |

---

## 2. Send this to IT (copy and paste)

> Hello — I'm setting up an internal web app for the ITS Events AV team ("AVL Tech Hub"). I need three things:
> 1. **A Linux virtual machine** (Ubuntu 22.04/24.04, 2 CPU, 2 GB RAM, 40 GB disk) with a login for me and permission to use `sudo`. Docker installed if you allow it (otherwise Node.js 22).
> 2. **A DNS name** such as `hub.yourorg.edu` pointing to the VM's public IP address.
> 3. **Firewall: open inbound ports 80 and 443** to that VM (80 is only used to get the HTTPS certificate and redirect to HTTPS).
>
> Also: tell me where the VM's backups go, and whether I may copy nightly app backups to a network share or OneDrive/SharePoint folder. The app stores people's names and sign-in accounts for our team and training records.

Write down the answers: **server address, web address, who to call**.

---

## 3. Option A — Docker (recommended)

Run these on the server (IT can give you a login with SSH — a text window to the server). Lines starting with `$` are what you type; do not type the `$`.

### 3.1 Get the app onto the server
```
$ sudo apt-get update && sudo apt-get install -y git
$ git clone <the address of your repository> avl-hub
$ cd avl-hub/avl-hub
```
(If `docker` is not installed: follow https://docs.docker.com/engine/install/ubuntu/ — IT may already have done this.)

### 3.2 Write the settings file
```
$ cp .env.example .env
$ nano .env
```
Change only these lines (use the arrow keys; **Ctrl+O, Enter** saves; **Ctrl+X** exits):

| Line | Put |
|---|---|
| `DOMAIN=` | your web address **without** `https://`, e.g. `hub.yourorg.edu` |
| `SHAREPOINT_HOSTS=` | your SharePoint address, e.g. `yourorg.sharepoint.com` (strongly recommended: only your SharePoint videos can be embedded) |
| `MFA_ENCRYPTION_KEY=` | *(optional)* turns on **two-step sign-in** (authenticator app) for people who want it. Make the key with `openssl rand -hex 32` and paste the 64 characters. **Keep a copy in your password manager** — it is deliberately not in backups. Leave blank to keep the feature off. |
| `BRAVE_API_KEY=` | *(optional)* web-search key. Leave blank to keep search off. |
| `ANTHROPIC_API_KEY=` | *(optional)* AI-drafting key. Leave blank to keep AI off. |

Never paste a key anywhere else (email, chat, the repository). It lives only in this file, on the server. The file is already excluded from the repository.

### 3.3 Start it
```
$ docker compose up -d --build
```
The first time takes a few minutes. Then check it:
```
$ docker compose ps
$ docker compose exec app node scripts/doctor.js
```
`doctor` explains in plain words what is fine (✔), worth fixing (⚠) or blocking (✖). At this point it will say there is no administrator yet.

### 3.4 Create the first administrator (one time)
```
$ docker compose run --rm app node scripts/create-admin.js yourusername "Your Full Name"
```
It asks you to type a password (nothing shows as you type) twice. **There is no default password anywhere.** The command refuses to run again once an administrator exists. You will be asked to choose your own password at first sign-in.

### 3.5 First sign-in and setup
1. Open `https://hub.yourorg.edu` in a browser. (If you see a certificate warning, wait two minutes and retry — the certificate is being issued. If it persists, see the table at the end.)
2. Sign in with the username and password from 3.4, then choose a new password (12+ characters).
3. **Admin → Official source domains:** add the manufacturer websites your team trusts (e.g. `shure.com`). Web research and "Manufacturer" items only ever use these.
4. **Admin → Create an account** for each person. The screen shows a temporary password **once** — give it to them privately. They must change it at first sign-in.
5. **Roles.** Four are built in: *Leader/Admin* (everything, cannot be edited), *Trainer* (writes training, scores, signs people off), *Technician* (day-to-day use, takes training), *Viewer* (read only). Under **Admin → Roles and permissions** you can **create your own** (for example “Camera Operator”, or “Reviewer” who may approve but not edit) by ticking exactly what that role may do, and change the built-in Trainer/Technician/Viewer roles (with “Reset to defaults” if you regret it). Changes apply immediately. Everyone signed in can *read* everything; permissions are for *changing* things. Details in §7.

You can stop here. Backups already run every night at 02:15 server time (section 6).

---

## 4. Option B — without Docker (systemd)

For IT-run servers. Needs Node.js 22 (https://nodejs.org) and Caddy (https://caddyserver.com/docs/install) or any HTTPS reverse proxy.
```
$ sudo useradd --system --create-home --home-dir /opt/avl-hub avl
$ sudo -u avl git clone <repository address> /tmp/avl && sudo -u avl cp -r /tmp/avl/avl-hub/. /opt/avl-hub/
$ cd /opt/avl-hub && sudo -u avl npm ci --omit=dev
$ sudo -u avl cp .env.example .env && sudo -u avl nano .env      # set NODE_ENV=production, TRUST_PROXY=1, SHAREPOINT_HOSTS, optional keys
$ sudo cp deploy/avl-hub.service deploy/avl-hub-backup.service deploy/avl-hub-backup.timer /etc/systemd/system/
$ sudo cp deploy/Caddyfile.systemd /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile      # put your real web address
$ sudo systemctl daemon-reload && sudo systemctl enable --now avl-hub avl-hub-backup.timer && sudo systemctl restart caddy
$ cd /opt/avl-hub && sudo -u avl node scripts/create-admin.js yourusername "Your Full Name"
$ sudo -u avl node scripts/doctor.js
```
Then continue at 3.5.

---

## 5. Putting it on phones and Macs

* **iPhone / iPad:** open the address in **Safari** → Share button → **Add to Home Screen**. Open it once online and look around (this saves your data for offline use). Reopen it online now and then — iOS may clear the offline copy of apps that go unused for weeks.
* **Mac:** Safari → File → **Add to Dock**. (Chrome/Edge: the install icon in the address bar.)
* **Offline:** the app opens without signal and shows what you viewed. Changes you make are saved on the device and sent automatically when you're back online. The line at the top always says **"All changes saved"** or **"N changes waiting to sync"**. Do not sign out while changes are waiting — you will be warned.

---

## 6. Backups (read this once, test it once)

* **Automatic:** every night at 02:15 the app makes a complete, verified copy of the database and all uploaded files (kept: last 14).
* **Where:** Docker — inside the `avl-data` volume at `/data/backups`. Without Docker — `/opt/avl-hub/backups`. The backup folder is readable only by its owner (it contains password hashes).
* **A backup on the same disk does not protect you from losing the server.** Under Docker: put `BACKUP_COPY_TO=/offsite` in `.env`, and set `OFFSITE_DIR` there to a folder **on the server** that is a mounted network share (default `./offsite`, which is just a folder next to the app — fine for a test, not protection). Without Docker: set `BACKUP_COPY_TO` to the path of that folder. Or ask IT to include the backup folder in their server backups. **Admin → Backups, export and import** shows how old the newest backup is. Ask IT where is appropriate for records that include names.
* **Check it is working:** `docker compose exec app node scripts/doctor.js` says how old the newest backup is. Make one now: `docker compose exec app node scripts/backup.js`.
* **Restoring** (and practising a restore) is described step by step in `docs/BACKUP.md`. **Please do one practice restore on a spare machine in the first month.** (Restore refuses to run while the app is running.) A backup you have never restored is a hope, not a backup.

---

## 7. Everyday administration

| I want to… | Do this |
|---|---|
| Add a person | Admin → People → Create an account |
| Someone forgot their password | Admin → **Reset password** next to their name; give them the temporary one |
| Someone is locked out (too many wrong tries) | Admin → People: the row says **“Locked out for about N more minutes”** with an **Unlock now** button (it also unlocks itself after 15 minutes). The page also shows when each person last signed in. |
| Someone left | Admin → **Disable** (their history stays; they can no longer sign in) |
| Change someone's role | Admin → the role dropdown next to their name |
| Make a new kind of role (say, someone who can approve equipment but not edit it) | Admin → Roles and permissions → **New role**, tick the permissions, save, then give it to people. Each permission has a one-line explanation. |
| Change what a role can do | Admin → Roles and permissions → **Edit** (applies to everyone with that role straight away) |
| Someone lost their phone (two-step sign-in) | Admin → **Reset two-step** next to their name. They can set it up again. |
| Require two-step sign-in for a role | Admin → Roles and permissions → Edit → tick *Require two-step sign-in* (only a Leader/Admin can change this). Those people must set it up before they can do anything else. (Needs `MFA_ENCRYPTION_KEY`.) |
| See who did what | Admin → Recent activity (audit log): plain-language entries naming who and what, with a *Show* link for details (versions, scores, before/after) and *Show older activity* |
| Check health | `docker compose exec app node scripts/doctor.js` |
| Move content to another install | `Admin → export` / import — see `docs/BACKUP.md` (this is *not* a backup) |

### Roles and permissions — what to know
* **You can only give what you have.** Someone allowed to manage roles can only give permissions they hold themselves, and can only change roles that have no more power than their own. Someone allowed to manage people cannot reset an administrator's password, create administrators, or give anyone a more powerful role than their own. This stops a "people manager" quietly becoming an administrator. The Leader/Admin role itself cannot be edited or deleted, and there is always at least one active administrator.
* **A role with people in it cannot be deleted** (move them first).
* **“Take training” makes someone a trainee.** People whose role has it appear in the skill matrix and can be scored and signed off. A trainer can never sign off or score themselves, whatever their role.
* **Sign-off needs approved material.** Nobody can be signed off on a module that is still a draft, or that was edited after approval and is waiting for review. Whoever holds *Approve training material* approves it (by default: only Leader/Admin).
* Every role change is in the audit log with before and after.

### Two-step sign-in (optional)
Off by default and entirely voluntary. If you set `MFA_ENCRYPTION_KEY` (§3.2), anyone can turn it on under **My account** (their name at the top of the screen): they scan a picture with an authenticator app and get eight one-time recovery codes. You can also *require* it for specific roles. Things to know:
* **The key is not in backups, on purpose** — a stolen backup alone cannot bypass the second step. Keep it in your password manager. If it is ever lost: people can still sign in with a recovery code, and you can reset people (Admin → Reset two-step, or `npm run reset-mfa -- <username>` on the server). If the key is missing at start-up the server **refuses password-only sign-in for people who enrolled** (it never silently skips the second step), and `doctor` says so.
* Lost phone and recovery codes: Admin → **Reset two-step**. Everyone locked out including all admins: `reset-mfa` on the server.
* It protects against stolen or guessed passwords. It is not a defence against someone tricking a person into typing a code into a fake site; Microsoft sign-in (later) is the stronger answer.

### Updating the app
```
$ docker compose exec app node scripts/backup.js        # always back up first
$ git pull
$ docker compose up -d --build
```
Database changes are applied automatically at start-up. If anything looks wrong after an update, restore the backup you just made (`docs/BACKUP.md`). Under systemd the helper commands (`doctor`, `restore`, `reset-password`…) read the same `.env` as the app, so they see the same settings.

### Single sign-on later
Sign-in is local username + password for now. The code has a documented place for Microsoft Entra ID (`server/auth/oidc.stub.js`); adding it later does not change anything else. Ask ITS for an "app registration" when you are ready — nothing is needed from them now.

---

## 8. If something goes wrong

| What you see | Likely reason | What to do |
|---|---|---|
| Browser says the site can't be reached | DNS not pointing at the server yet, or ports 80/443 closed | Ask IT to confirm the DNS name and firewall (section 2) |
| Certificate warning / "not secure" | Certificate still being issued, or DNS/ports wrong | Wait 5 minutes; then `docker compose logs caddy` and send the last lines to IT |
| `docker compose up` stops with "Set DOMAIN in .env" | `.env` missing or `DOMAIN=` blank | Section 3.2 |
| Image build fails | Server cannot reach the internet to download packages | Ask IT to allow outbound HTTPS to npmjs.org, Docker Hub and github.com during the build |
| "Too many requests" for everyone | `TRUST_PROXY` not set behind the proxy | Make sure `.env` has `TRUST_PROXY=1` (Docker sets it for you) |
| Can sign in but offline mode doesn't work on iPhone | Not using HTTPS, or opened in a Safari tab rather than the Home Screen app | Use the HTTPS address; add to Home Screen; open once online |
| Video won't play in a lesson | SharePoint sharing/embedding settings | Use SharePoint's own **Share → Embed** link and check the video is shared with the team |
| `doctor` says ✖ | Read the line — it says what to run | Fix, re-run `doctor` |
| Nobody can sign in as an administrator (forgotten password, locked out, or lost phone) | — | On the server: `docker compose run --rm app node scripts/reset-password.js yourusername` (without Docker: `node scripts/reset-password.js yourusername`). It asks for a new temporary password, unlocks and re-enables the account, and is recorded in the audit log. If their phone for two-step sign-in is also lost: `docker compose run --rm app node scripts/reset-mfa.js yourusername`. Only someone with access to the server can do either. |

---

## 9. What was and was not tested

**Tested automatically (every change):** sign-in, lockout, roles and permissions on every action, sign-off rules, equipment and photo-pin sourcing rules, file upload limits, offline opening, queued changes, conflict rules, backup, restore (including failure and rollback), import, production-mode cookies and security headers, and a browser run of the first-run steps in sections 3.4–3.5 (without Docker).

**Not tested — please check with real people:** a real iPhone (install, camera, offline over days), your server and hosting, your domain and HTTPS certificate, the Docker image build, your SharePoint embeds, the real web-search and AI services (tested with stand-ins only), and screen readers (VoiceOver/NVDA). The first week, treat it as a pilot with two or three people.
