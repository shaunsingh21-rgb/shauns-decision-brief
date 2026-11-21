# AVL Tech Hub: performance and capacity (SRE report)

Method: the real `server/index.js` as its own process, `NODE_ENV=production`, `TRUST_PROXY=1`, argon2 library defaults (argon2id, 64 MiB, t=3, p=4), SQLite WAL, server pinned to **2 CPUs** (`taskset`), load generator on the other 2. Node 22. Data is SAMPLE only: 40 users, 50 modules x 10 questions x 4 skills, 20,000 audit rows, 200 panels (4 pins, one 180 KB photo each), 300 issues, 150 updates, 12 fields + 6 install steps per item, library of 100 / 1,000 / 5,000 items (DB 6 / 11 / 30 MB). The test machine was shared with other jobs, so absolute numbers carry noise of roughly +-20%; ratios are solid. `API_RATE_MAX` was raised for the latency tables only (closed-loop load would otherwise be throttled at 600/min); it was NOT raised for the prefetch test.

## 1. Headline numbers

| Measure | Result |
|---|---|
| Start-up to first healthy response | 166-184 ms (2 CPUs) |
| RSS idle | 71 MB |
| RSS after load (31 signed-in users, all endpoints) | 250-270 MB |
| RSS peak during a 40-person sign-in burst | 338-354 MB (4 x 64 MiB argon2 in flight) |
| One sign-in | 72-146 ms |
| Sign-in throughput (argon2 default cost) | 12-16 per second |
| 40 people sign in at once | all done in 2.5 s (4 CPUs) / 3.3 s (2 CPUs); last person waits that long |
| Event loop during that burst | JSON API stays responsive (`/api/me` p50 5 ms, max 120 ms) but **file reads stall for the whole burst**: static JS and photos waited **3.3 s** (section 3, fix 3) |
| Writes (PATCH equipment + POST issue, each also writes an audit row), 1 / 10 / 30 writers | 650 / 970 / 1,090 ops/s; p95 2.6 / 21 / 45 ms; **0 errors, 0 SQLITE_BUSY** in 15,000 writes; 30 writers on the same row: 1,000 ops/s, 0 errors |
| Backup, 30 MB DB + 200 photos (72 MB folder) | idle 0.41 s; during 1,100 writes/s 1.1 s; passes integrity check; writes unaffected (p95 18 ms) |
| Restore of that backup | 0.45 s |
| 150 MB video upload (localhost, so server cost only) | 0.25 s, RSS +36 MB (streams to disk, never buffers); other requests during it p50 2.5 ms; download streams, Range gives 206 |
| First-load static weight (/, css, 7 js, 11 view js, 4 icons, manifest) | 25 files, 181 KB raw, **79 KB gzip** (what Caddy sends; Node itself sends no compression); service worker precaches all 26 entries once |
| OCR vendor files | 11 MB on disk, never precached; fetched only when someone opens the OCR step in the wizard: about 7 MB raw / 4.4 MB gzip for one run (one of the two 3.9 MB cores + 2.9 MB language data + workers). Not available offline. |
| ETag / 304 | works for static files and every API route; the app does not use it (API sends `Cache-Control: no-store`) |

## 2. Latency of the main GETs (server on 2 CPUs; p50 / p95 / p99 ms), 1,000 items

See `results/t2_tables.md` for 100 and 5,000 as well. Selected rows:

| Endpoint | raw KB (gzip KB) | 1 user | 10 users | 30 users |
|---|---|---|---|---|
| equipment list, 100 items | 21 (3.4) | 1 / 3 / 6 | 9 / 23 / 34 | 24 / 47 / 71 |
| equipment list, 1,000 items | 212 (31) | 4.5 / 8 / 12 | 35 / 82 / 108 | 105 / 197 / 979 |
| equipment list, 5,000 items | 1,061 (155) | 23 / 28 / 31 | 171 / 386 / 818 | 451 / 3,483 / 3,759 |
| equipment detail | 2.5 (0.5) | 0.7 / 1.3 / 6.8 | 4 / 13 / 19 | 14 / 31 / 49 |
| modules list (50) | 17.5 (2.5) | 1.8 / 2.2 / 6.6 | 13 / 32 / 41 | 43 / 82 / 108 |
| module detail | 2 (0.7) | 0.5 / 0.8 / 2.9 | 3 / 11 / 16 | 12 / 26 / 36 |
| **progress (one person, 50 modules)** | 31 (6.4) | **22.6 / 39 / 44** | 107 / 241 / 548 | 151 / 300 / 1,019 |
| skill-matrix (40 people x 200 skills) | 184 (17) | 7.7 / 16 / 23 | 78 / 157 / 221 | 215 / 434 / 1,986 |
| issues (300) | 224 (17) | 2 / 5 / 8.5 | 15 / 34 / 48 | 55 / 106 / 369 |
| updates (150) | 72 (8.5) | 1.3 / 3.8 / 7 | 9 / 20 / 26 | 28 / 52 / 67 |
| audit limit=100 | 25 (2.8) | 1.7 / 4 / 20 | 17 / 47 / 69 | 62 / 117 / 203 |
| audit limit=500 | 139 (10) | 6 / 31 / 47 | 76 / 137 / 169 | 195 / 406 / 2,793 |
| people | 4.8 (1.1) | 1.7 / 6.7 / 29 | 14.5 / 50 / 71 | 61 / 100 / 130 |
| panels (200) | 47 (14) | 6.3 / 11 / 18 | 52 / 118 / 173 | 156 / 358 / 1,570 |
| /api/me | 0.6 (0.3) | 0.6 / 1.8 / 5.7 | 3.9 / 14 / 20 | 13 / 33 / 44 |

(30 users hammering in a closed loop with no think time is far harsher than 30 real people: each real person issues a request every few seconds.)

## 3. Findings with before/after (prototypes in `proto/`, a COPY; diff in `proto-changes.diff`)

1. **The app's own background prefetch is rejected by the app's own rate limit** (functional bug, not just speed). `warmCache()` issues about 1,000 requests (4 per item for up to 150 items, 2 per module, 2 per panel, plus lists) and the per-person limit is 600/min. Measured with default settings: technician 1,009 requests attempted, **409 got HTTP 429** (40%), at 100, 1,000 and 5,000 items alike (it is capped at 150 items), so the panels/photos at the end of the queue never reach the offline copy. Worse, the person's next 60 s of ordinary requests also get 429 (`/api/me` -> 429, Retry-After 60 after 650 requests), and the sync queue halts on 429. At 37 people opening the app together: 36,447 requests, 14,847 rejected. Also: only the **first 150 items alphabetically** are ever cached offline, however large the library gets.
   Prototype (separate, larger read budget `API_READ_RATE_MAX=6000`): 0 rejected. BUT it exposes the next cost: with no 429 the prefetch pulls **29 MB per person** (150 photos at 180 KB; real phone photos will be larger) and 37 people at 9:00 pull 1 GB in 22 s. So pair it with a polite photo prefetch (one at a time, only on Wi-Fi/unmetered, or on first view) or the snapshot below.
   Interactive latency during the 37-person stampede: p50 57 ms, p95 105 ms, max 671 ms (fine); the damage is bandwidth, not CPU.
2. **Bulk snapshot endpoint is warranted.** Prototype `GET /api/snapshot` (150 items + fields + install steps + documents + panels/pins + all modules with quiz/skills/videos + updates + issues): **1 request, 1.2 MB raw / 113 KB gzip, 10 ms of server time** at every library size, versus about 1,000 requests, 1.3 MB raw plus roughly 1 MB of repeated security headers (each response carries ~1 KB of helmet headers), 600 limiter tokens and ~1 s of server CPU per person. 37 people: 0.4 s of server time instead of ~20 s of saturated server. Client change needed in `public/js/api.js warmCache` to write each piece into the cache keys it already uses (not prototyped). Add `?since=` later if libraries pass a few thousand.
3. **Sign-in burst starves file reads.** argon2 holds the 4 libuv threads, and `express.static`, photo `sendFile`, and multer's disk writes use the same pool. During a 40-person burst a static JS or photo request waited **3.3 s** (UV_THREADPOOL_SIZE=8 does not help: 3.0 s, and peak RSS rises to 610 MB). Prototype: allow at most 2 concurrent password checks (`server/auth/local.js`, 8 lines): photo p50 during the burst **3,333 ms -> 8 ms** (max 119 ms), static JS p50 5 ms, burst total 3.8 s instead of 3.5 s, peak RSS 354 -> 250 MB. Cheap and safe: same lockout logic, same hashing cost.
4. **Missing indexes** (EXPLAIN QUERY PLAN showed full scans; `migrations/008_perf_indexes.sql` in proto adds 17): quiz_questions(module_id), practical_skills(module_id), practical_scores(trainee_id,skill_id,event_at DESC), quiz_attempts(user_id,module_id,created_at), photo_panels(equipment_id), panel_pins(panel_id), files(equipment_id,purpose,created_at), lesson_videos(module_id,position), video_checkpoints(video_id,at_seconds), issues(updated_at), equipment_updates(created_at), equipment(name) live, equipment_fields(equipment_id,provenance), idempotency(created_at), sessions(expires_at) and two more. These tables are append-only or grow for years (quiz attempts, practical scores), so the scans get worse with age. Measured, 1,000 items:

| Endpoint | baseline c1 | + indexes | + indexes and bulk progress |
|---|---|---|---|
| progress for one person | 22.4 ms (43/s) | 5.9 ms | **1.3 ms (709/s)** |
| progress, 10 users, p50 | 204 ms | 72 ms | **9.7 ms** |
| modules list | 2.1 ms | 1.0 | 0.6 |
| panels list | 6.2 ms | 1.2 | 1.0 |
| equipment list | 3.5 ms | 2.7 | 2.3 |

5. **N+1 in `GET /progress/:userId`** (`server/routes/training.js progress()`): per module it runs 6-7 queries and recomputes the SHA-256 of the whole quiz (50 modules = ~350 queries + 50 hashes per call; trainers and admins prefetch it for up to 100 people, so a trainer's prefetch is 100 of these = about 2.2 s of blocked event loop every 10 minutes once finding 1 is fixed). Prototype `progressAll()` does it in 5 queries; output verified **byte-for-byte identical** to the original for 5 users (`t8_s1000.txt`), 22.4 -> 1.3 ms with indexes. The skill matrix is the other heavy read (7.7 ms, 184 KB; the payload is the cost, not the query).
6. **Equipment list at thousands of items.** 217 bytes per item: 1,000 items = 212 KB, 5,000 = 1.06 MB (155 KB gzip), 23 ms single user, p99 3.7 s with 30 simultaneous. Prototype memoising the serialised list until `(count, max updated_at, sum version)` changes (every write path bumps those): 5,000 items **23 -> 4 ms**, 30 users p50 451 -> 76 ms, p99 3,759 -> 405 ms; 1,000 items 30 users p99 439 -> 58 ms. Real fix later: search/paging on the server and `?since=`.
7. **Slow phone uploads of a big video die at 5 minutes.** Node's default `requestTimeout` is 300 s. Test: 150 MB at 3.6 Mbit/s (450 KB/s) -> **HTTP 408 after 330 s with 152 of 157 MB already sent**. Any uplink under about 4 Mbit/s fails every attempt (venue Wi-Fi, cellular). Fix: `server.requestTimeout = 0` after `app.listen` (headersTimeout 60 s still guards slow-loris); With the fix the identical upload completes: **HTTP 201 after 341 s** (`t7_proto.out`).
8. **Backups copy every uploaded file every night and keep 14.** Backup folder = full copy of `data/uploads/files` (`scripts/lib/backup.js` `fs.cpSync`). Files are immutable (stored under random ids), so 14 nights of 30 videos x 150 MB is 4.5 GB x 14 = **63 GB** of disk on the same small VM. Measured: copying 8 x 150 MB = 0.62 s and 1.2 GB per backup, versus hard-linking them 0 ms and 0 extra bytes (`du` confirms). Fix: `fs.linkSync` unchanged files from the previous backup (caveat: `lockTree` chmod 0600 then applies to the shared inode, harmless since the app owns them; fall back to copy across filesystems; BACKUP_COPY_TO off-box copies stay full).
9. **Static assets are fine.** 79 KB gzip for the whole app, all precached by the service worker; minifying would save maybe 15 KB gzip and lazy-loading views gains nothing because the worker fetches all of them on first visit anyway. Compression only exists in Caddy (`encode gzip` in both Caddyfiles): if someone deploys behind anything else, the 212 KB-1 MB lists go out uncompressed (7x larger). A 2-line `compression()` middleware would make that independent of the proxy.
10. **Photos prefetched silently over cellular.** With the limiter fixed a first run pulls up to 150 full photos per device (about 27 MB at 180 KB each, 60+ MB at typical phone-photo sizes after the client's resize). Make it Wi-Fi only (`navigator.connection.saveData`/`type`) or lazy.

## 4. Capacity statement

On one 2-CPU / 2 GB VM with SQLite, **this setup comfortably serves 40 simultaneous users, and about 10 times that in steady state**: typical screens answer in 1-15 ms of server time, writes run at about 1,000 per second with no lock errors, memory stays under 400 MB, the 150 MB upload does not buffer. At a few thousand items, 20,000+ audit rows and 50 modules nothing is slow for one person (worst single call: equipment list at 5,000 items, 23 ms; progress 22 ms).
**The first thing to break is not CPU but the app's own prefetch against its own rate limit, from the first week of real use**: any library over about 60 items makes every signed-in person's first minute 40% 429 errors and incomplete offline data. After that, in order: file reads stalling for 3 s while many people sign in at once, the 1-5 MB equipment list at 30 simultaneous (p99 3.7 s at 5,000), the 300-second upload cutoff for slow phones, and disk growth from full nightly backups of videos.

## 5. Top fixes, ranked (value / effort)

1. Raise/separate the read budget in the API limiter (`server/index.js apiLimit`; S, proven 409 -> 0 rejections) and make photo prefetch gentle (client; S-M).
2. Migration 008 indexes (S, proven; `proto/migrations/008_perf_indexes.sql`).
3. `progressAll()` (S-M, proven identical output, 22 -> 1.3 ms).
4. Cap concurrent password checks at 2 (S, proven 3.3 s -> 8 ms for file reads).
5. `server.requestTimeout = 0` (S).
6. `GET /api/snapshot` plus client `warmCache` rewrite (M, server side proven: 1 request, 113 KB gzip, 10 ms).
7. Hard-link unchanged files in backups (S-M, proven 0 bytes).
8. Memoise the equipment list (S, proven 5x), then server-side search/paging (M-L) when the library passes a few thousand.
9. `compression()` middleware as a proxy-independent fallback (S).
