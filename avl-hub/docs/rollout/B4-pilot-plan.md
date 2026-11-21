# AVL Tech Hub: 4-week pilot plan

Facts this plan relies on (from docs/DECISIONS.md and tested): accounts are created by the leader; no email; offline saves what the phone has seen and sends changes later; quizzes are marked only when online; only the leader approves by default; nothing is guessed (VERIFY); data is as good as what the team puts in. Nothing here promises a feature the app lacks (no email reminders, no reports export beyond content export and the audit log, no Microsoft sign-in, no tested iPhone behaviour).

## Who (6 to 8 people)
| Role | Count | Why |
|---|---|---|
| Team leader | 1 | Runs set-up, approves, answers questions. |
| Trainer | 1 | Writes one module, scores, signs off. |
| Technicians | 4 to 5 | Mix: one who likes new tools, one sceptic, one who works in poor-signal rooms (the offline test), at least one iPhone and one other phone. |
| Observer | 1 (can be the leader) | Writes down every "huh?" and every workaround. |

Pre-conditions (do not start before): hosted at a real HTTPS address, a recent backup shown on Admin, official websites listed, two sample pieces of equipment and one approved module loaded, a named person to ask, test of sign-in on every pilot phone.

## Week by week
| Week | Try this | Measure | Collect |
|---|---|---|---|
| 0 (set-up, not counted) | Leader set-up (quick start for leaders), install on all phones, 30-minute walkthrough | Everyone signed in and changed password: yes/no each | Hand-written list of confusing moments |
| 1: Look things up | On a real event or load-in, use the app to find equipment and tick installation steps. Log at least one issue per person. | Sign-ins per person; steps ticked; issues logged; time to find an item (stopwatch, 3 trials each, vs the old way: manual or message) | 2-minute stand-up each Friday: "one thing that helped, one thing that got in the way" |
| 2: Fill the gaps and go offline | Technicians add or correct equipment details (leave unknowns as VERIFY). Everyone uses it once in the room with the worst signal; log an issue and tick a step offline, then reconnect. | Count of VERIFY items resolved; offline changes sent vs "needs attention"; any lost work (must be 0) | Observer notes; screenshot any message people did not understand |
| 3: Training | Trainer's module approved; every technician takes the quiz; trainer scores one practical each and signs off at least two people. | Quiz pass rate and attempts; time trainer spends per sign-off; sign-offs recorded; skill matrix correct? | Trainer interview (15 minutes); technician quick survey |
| 4: Team leader's week | Approve waiting material, review the audit log and issues, restore-readiness check (backup age), decide on wider rollout | All of the criteria below | Full survey (below) and a 45-minute retrospective |

## Measures (write numbers down weekly; sources are screens that exist)
- Adoption: people who signed in this week (Admin > People "Last signed in"); activity counts from the audit log (Admin, Recent activity).
- Usefulness: issues logged, steps ticked ([n] of [m] done), VERIFY count falling, quizzes taken, sign-offs.
- Trust: number of times someone says they still used the old way and why (observer list).
- Reliability: lost or duplicated work (target 0), "needs attention" items (note each), time offline before sync worked.
- Effort: leader minutes per week (target under 60 by week 3), trainer minutes per sign-off.
Not available in the app: usage charts, per-screen analytics, time-on-task. Use the stopwatch, the audit log and the survey.

## Go / no-go (decide in week 4)
Go if **all** hold:
1. 80% or more of pilot technicians signed in each of the last two weeks, without being chased.
2. Zero cases of lost or wrongly attributed work (offline included). One is a no-go until explained and fixed.
3. At least 5 issues logged by technicians and at least 2 people signed off through the real flow.
4. Median "find an item" time is no worse than the old way.
5. Survey: at least 6 of 8 say they would be annoyed if it were taken away, or mean score 4 or more out of 5 on questions 1 to 3.
6. Backup shows fresh on Admin throughout, and the leader reports under an hour a week.
7. No unresolved security or privacy question (retention of training records decided with ITS/HR).
Pause (extend two weeks, fix) if only 1, 4 or 5 fail. No-go if 2 or 7 fail.

## Roll back
- Nothing in the pilot replaces the old way until go: keep the current manual, spreadsheet or chat as the source of truth for the whole pilot and write the old sources on the first day.
- To stop: tell the team the old way is live again (message), then on Admin download a **content export** (equipment, training, issues; not accounts or sign-offs) and take a final **backup** (server), so nothing is lost. Disable accounts from People if required. Offline users: ask them to open the app online once so waiting changes are sent before the stop date, then sign out.
- To go back after a bad change: restore from backup (needs the server stopped; it checks the backup first and rolls back on failure). Restore loses everything after the backup, so announce a freeze first.

## Feedback survey (8 questions, 3 minutes; anonymous if the team prefers)
1. It helped me find what I needed for a job. (1 strongly disagree to 5 strongly agree)
2. I trust what the app shows (VERIFY, source labels, approvals). (1 to 5)
3. If it were taken away tomorrow I would be annoyed. (1 to 5)
4. Which job did you use it for most? (finding equipment / installation steps / logging issues / training / other)
5. Which screen or message confused you? Name it.
6. Did you lose or doubt any of your work, online or offline? What happened?
7. What did you still do the old way, and why?
8. One change that would make you use it every week.
Add for trainer and leader: how many minutes did your part take this week?

## What to tell the team (announcement email, plain text, send from the leader)

Subject: Trying out AVL Tech Hub for four weeks (what to expect)

Hi all,

For the next four weeks [NAMES] will try a new tool called AVL Tech Hub. If it earns its place we will all use it. If not, we stop and nothing is lost.

What it is
A phone app (and web page) with our equipment information, installation steps, training modules and a place to log issues and lessons learned. Every fact shows where it came from (the manufacturer, our team, an AI draft, or "VERIFY" meaning nobody has confirmed it). It never guesses. If it says VERIFY, check before you rely on it.

What it is not
It is not a replacement for the manufacturer's manuals, and it will not install updates for us. During the pilot, keep using [the current way] as well. It does not send email reminders. It is only as good as what we put in, so some entries will start empty or marked VERIFY.

What works with no signal
After you have opened a page once with signal, you can read it, tick installation steps, log issues and answer quizzes with no signal. Changes are saved on your phone and sent when you are back online. Quiz answers are marked once you are online. Pages you have not opened before need signal. Please do not sign out while changes are waiting. If you do not open the app for several weeks, your iPhone may clear its saved copy, so open it online now and then.

What you need to do
1. Come to the 30-minute walkthrough on [DATE, TIME, PLACE].
2. Install it, sign in with the temporary password you will get from me, and choose your own.
3. Use it for [one real job] in week 1 and tell me honestly what got in the way.

Who can see what
Everyone signed in can read equipment, training and issues. Your training scores and sign-offs are recorded under your name and visible to trainers and the team leader. [Insert the retention answer once ITS/HR confirms it.]

Who to ask
[TEAM LEADER] for passwords, locked accounts and anything that looks wrong. [NAME] for training questions.

Thanks for trying it, and for being blunt.
[NAME]
