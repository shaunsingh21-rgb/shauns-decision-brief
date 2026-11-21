# Risks of adoption: why teams abandon tools like this, and what counters each

"In the app" means a change that exists today or a small change I propose (marked PROPOSED). "In the rollout" is something people do.

| # | Why teams abandon it | Early sign | Counter in the app | Counter in the rollout |
|---|---|---|---|---|
| 1 | **Empty on day one**: people look up a mixer, find nothing, never come back | Searches with no results, a short equipment list | Wizard (photo of the label) makes adding fast; VERIFY allows saving with unknowns | Leader and one technician load the 10 most-used pieces before launch; target 10 before week 1 |
| 2 | **Information feels untrustworthy** (wrong spec found once) | "I still check the manual" | Source chips on every value, VERIFY never guessed, approvals recorded with the version | Say plainly in the announcement that VERIFY exists; the first wrong value found is thanked, corrected and discussed |
| 3 | **Old way stays easier** (group chat, spreadsheet) | Questions asked in chat that the app answers | Search, install checklist | Answer chat questions with "it is in the Hub: [link]" for four weeks; do not run both sources of truth after go |
| 4 | **No signal in the room**, work lost or doubted once | A technician says "it did not save" | Offline saving, header status ("Saved on this device"), Sync page; changes never silently dropped (needs attention) | Teach the three offline messages in the walkthrough; test in the worst room in week 2; zero lost work is a go criterion |
| 5 | **Confusing words** (sync, VERIFY, sign-off vs approve, pin) | Questions about words | Plain-language pass (A1-wording-audit.md): glossary, rewritten errors | Print the 8-term glossary on the quick starts |
| 6 | **Error messages blame or dead-end** | People stop after an error | Rewrites of the worst 40 strings | Tell people the first move is "reload and try again, then tell [leader]" |
| 7 | **Only the leader gets value; everyone else is giving data** | Leader is the only one signing in | Technicians get checklists, issues, and their own training record | Show each person what they get in return by week 1 (their ticked steps, their sign-offs) |
| 8 | **Leader becomes the bottleneck** (approvals pile up) | Items sit at Needs review | Approval queue visible by status; custom roles allow a Reviewer (DECISIONS F5) | Fixed approval time: Fridays, 30 minutes; consider a Reviewer role after the pilot |
| 9 | **Passwords and two-step friction**; lockouts on event days | Locked-out messages | Lockout visible to the leader with minutes left and Unlock now; two-step is optional | Everyone tests sign-in on their own phone before the event day; leader holds the reset duty on event days |
| 10 | **Training feels like surveillance** | Reluctance to take quizzes | Practice quizzes do not affect sign-off (photo quiz); only sign-offs are recorded | Be honest in the announcement about who sees scores; decide retention with ITS/HR before launch |
| 11 | **Trainer workload**: scoring and sign-off take longer than before | Trainer stops scoring | Skill matrix, "what is missing" list on sign-off | Measure minutes per sign-off in week 3; start with one level only |
| 12 | **Data entry fatigue** (long forms on a phone) | Half-filled records | Forms allow Draft and VERIFY; photo wizard | Ask for one correction per job, not a database project |
| 13 | **No champion / owner** | Nobody answers questions | Audit log shows who did what | Name an owner and a deputy; weekly 10 minutes |
| 14 | **iPhone clears offline data after weeks unused** | Saved pages missing | Documented limitation; opens fine online | Tell people (done in the announcement); one event-week reminder to open it online |
| 15 | **Changes after launch break habits** (the app updates itself) | "It looks different" | A toast says the app was updated (wording to fix) | Post one line when it changes; do not change screens during event weeks |
| 16 | **Pilot ends with no decision** | Drift | Go / no-go criteria are written down | Retrospective booked on day one; decision recorded |
| 17 | **Security worry blocks it** (ITS/HR) | Questions from outside the team | Hardened (see docs/REVIEW-2026-11.md), audit log, sign-in lockout | Give ITS the two docs and the retention question before the pilot starts |
| 18 | **Single point of failure**: server down on an event day | App unreachable | Offline use for already-saved pages | Know who restores; backup freshness on Admin is checked weekly; keep a printed or exported copy of the key checklists for event days (use Download export) |

Biggest three for this team: empty content (1), distrust after one wrong value (2), and the old chat winning (3).
