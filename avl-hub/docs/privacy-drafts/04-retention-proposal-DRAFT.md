# AVL Tech Hub — records-retention proposal (DRAFT)

> **DRAFT for the institution's records manager, HR, counsel and privacy office. Not legal advice.** Numbers are *starting proposals with reasoning*, not requirements. The institution's own records schedule, HR rules, litigation-hold procedure and any FERPA analysis for student employees override everything here. **Open question for counsel:** are student-worker training records "education records" (employment that depends on student status) or employment records? That decides who may ask to see them and how long they must/may be kept.

## Principles
1. **Keep the proof, shed the surveillance.** Sign-offs and approvals are the team's evidence that someone was trained on a version of the material: keep them. Technical by-products (IP addresses, every quiz attempt, replay bodies, typed usernames) have no lasting value: shed them.
2. **Delete by schedule, not by request**, so that nobody has to remember.
3. **Pseudonymise before deleting**: replace the person with "Former team member" so records keep their integrity (append-only design), and delete the identifiers (username, password hash, MFA, sessions).
4. **Backups follow the same clock**, plainly stated: a deletion in the app reaches backups only when they age out.
5. **A litigation hold stops every deletion job** for the people/period concerned. Nothing in the proposed jobs runs while the hold flag is set.

## Schedule (proposal)

| Data | Today | Proposed default | Reasoning |
|---|---|---|---|
| Account row of a departed person | Forever; username + name visible | Disable at departure. **Anonymise 12 months after departure** (username, name, SSO id, hash, MFA removed) unless on hold. | Keeps a year for disputes, references, rehire; then identity goes. Training facts remain. |
| Sign-offs, approvals, practical scores (with scorer ids) | Forever | Life of employment **+ [N, suggest 3] years**, then keep only the anonymised sign-off (module, version, date) as content-history; delete free-text notes at the same time. | Matches typical personnel/training-record periods; confirm with HR. The *fact* of sign-off on a module version has lasting value; the *person's* detail doesn't. |
| Sign-off and practical **free-text notes** | Forever, copied into the audit log | Keep with the record; **redact 12 months after departure**. | Notes are where opinion and sensitive remarks end up. |
| Quiz attempts | Forever, every attempt | Keep newest passing attempt per module forever (with the record); **delete other attempts after 12 months**. | Raw attempts are noise and can show struggle; the sign-off already stores the quiz % used. |
| Video checkpoint responses, install ticks | Forever | 12 months | Formative only. |
| **Audit log** (sign-ins, edits, approvals, exports) | Forever, IP on every row | **Hot (in app): 24 months.** Security-relevant rows (`auth.*`, `user.*`, `role.*`, `export.*`, `import.*`, `restore`) **36 months** if ITS requires; forward to the institution's logging/SIEM instead of keeping it all in the app. | Long enough to investigate slow incidents and annual reviews; short enough to limit the permanent file of people's activity. |
| **IP address** in audit and sessions | Audit: forever. Sessions: while valid. | Keep full IP **90 days**, then truncate (IPv4 last octet, IPv6 last 80 bits) or null. | Needed for incident triage; has little value afterwards. |
| Failed sign-in records (typed username) | Forever in audit | **Stop recording what was typed** (record "unknown account" + a hash). Existing rows: delete/redact after 30 days. | A mistyped password in the username box is a credential in a log. |
| Idempotency/replay records | 30 days, with full response | **7 days, status only** | The offline queue retries within hours/days; bodies are unneeded. |
| Sessions | 12 h idle / 14 d | unchanged | Already short. |
| Search queries in audit (`research.search`) | Forever | 90 days, or log only the length | Free text typed to an outside service. |
| Uploaded files, deleted | Row + original name stay; bytes in backups | Null the original name at delete; bytes leave backups at the backup limit | Names often contain people's names. |
| Issues/lessons free text | Forever | Keep (equipment history has value). Provide an "edit/redact" path and tell people not to type personal data. | Content, not records about a person, as long as policy is followed. |
| **Backups, local** | newest 14 (about 14 days if nightly) | 14 daily + keep 1 monthly for 6 months **(optional)** | Disaster recovery vs. deletion promise. |
| **Backups, `BACKUP_COPY_TO`** | **Never pruned** | Same as local: **prune to the same limit** (code change, or a retention rule on the storage) | Today deletion never reaches this copy. |
| Browser data on devices | Wiped on Sign out only | Also wipe when the session ends or is rejected (401) and after N days idle | Proven gap. |
| Server console logs | unbounded by default | 30 days (journald `MaxRetentionSec`, Docker `max-file`) | Container hygiene. |

## Backup retention vs deletion promises (wording for the privacy notice)
"Removing or anonymising someone in the app takes effect immediately. Copies in backups are removed as those backups expire, within [14] days (local) and [N] days (off-server copy). We do not alter backups." If a stricter promise is needed, the only honest way is to shorten backup retention or to re-apply recorded deletions after a restore (keep a **deletion ledger**: person id + date; the restore procedure re-runs anonymisation for every ledger entry). Propose the ledger (see 05-P2).

## Litigation holds
Add a "hold" switch (per person or global) in Admin. While on: retention jobs skip, anonymise is refused, backup pruning keeps current folders, and the action is audited. Until built, procedure: **stop the retention jobs and set `BACKUP_KEEP` high, and copy the newest backup to the hold location** [`docker compose exec app node scripts/backup.js`; copy the folder named `avl-backup-…`].

## Review
Owner: [team leader]; annual review with records manager; first review after 3 months of use.
