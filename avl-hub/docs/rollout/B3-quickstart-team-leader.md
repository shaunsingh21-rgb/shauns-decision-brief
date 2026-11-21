# AVL Tech Hub: quick start for the team leader (first week)

You hold every permission, so you do the set-up and the approvals. Walked through as a leader account.

## Before anyone else signs in (Day 1, 45 minutes)
1. Sign in with the first administrator account, choose your own password (12 or more characters, not containing your username).
2. **Admin** page, top to bottom:
   - **People**: open **Create an account**. For each person enter username, display name, role. The app shows a **temporary password once**. Copy it into a private message to that person straight away. They must choose their own at first sign-in.
   - **Roles and permissions**: leave the four built-in roles (Leader/Admin, Technician, Trainer, Viewer) for the pilot. Defaults: technicians add and edit equipment, log issues, record updates and take training; trainers also write training, score and sign off; **only you approve** equipment and modules.
   - **Official source domains**: add the manufacturers' sites your team trusts (for example the website of a maker you buy from). A "Manufacturer" value is only accepted from a listed website. Nothing is listed at the start.
   - **Backups, export and import**: the page says **No backups found** until backups are scheduled (done on the server, see the backup guide). Do not start the pilot until this reads a recent backup. Download an **export** once for a content-only copy.
3. Decide the open questions in docs/DECISIONS.md section F: hosting address, official websites, SharePoint host, wording of rubric and status names, retention of training records (who owns that decision at ITS/HR).

## Day 1 to 2: put real content in, labelled as draft
- Add 3 to 5 pieces of equipment with the **Add equipment** wizard (photo of the label, confirm text, optional search, review). Anything you cannot confirm stays **VERIFY**.
- Ask a trainer to write one module with 5 questions and 3 skills.
- **Approve** them (button on each record). Approving with VERIFY items still open needs a written reason and is recorded. Do not do it for the pilot unless you must.

## Day 3: onboard people
Hold the 30-minute walkthrough (training outline). Everyone installs it, signs in, ticks a step, logs a test issue.

## Day 4 to 5: watch and answer
- **Admin**: People shows who has not signed in ("Never", "Must change password") and who is **locked out** with minutes left (**Unlock now**). Lost phone for two-step: **Reset two-step**.
- The **Recent activity (audit log)** at the bottom shows what happened and by whom. Open **Show** for details.
- The **Skill matrix** shows who has been scored.
- Review things sitting at **Needs review** and approve or send back by telling the author.

## Every week after
Check backup age on **Admin**; approve waiting material; read new issues; ask "what did you not trust?"

## Your lifelines
Forgotten password: **Reset password** on People. Locked out of every admin account: `reset-password` on the server (needs server access). Lost authenticator phone: another admin resets it; otherwise `reset-mfa` on the server.
