'use strict';
// Every leader-overview metric as plain SQL against the app's schema (+ proposed migration 008). Read-only, no new tables needed
// except recert_months / event_* / readiness_profiles. Each function takes an open better-sqlite3 handle.
const crypto = require('crypto');
const PASS_PCT = 80, PASS_SKILL = 2;            // same constants as server/routes/training.js
const iso = d => d.toISOString();

// Same fingerprint as training.js quizHash(): a score only counts for the quiz it was taken against.
function currentQuizHashes(db) {
  return db.prepare('SELECT id FROM training_modules').all().map(m => ({
    m: m.id, h: crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT id,prompt,options,correct_index FROM quiz_questions WHERE module_id=? ORDER BY rowid').all(m.id))).digest('hex') }));
}

// Trainees = active people whose role has training.take (same rule as the skill matrix).
const TRAINEES = `SELECT u.id, u.display_name, u.role, r.name role_name, u.last_login_at, u.created_at
  FROM users u JOIN roles r ON r.id=u.role
  WHERE u.disabled=0 AND EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role AND rp.permission='training.take')`;

// One row per (trainee, module): written and practical kept SEPARATE, plus the latest sign-off and whether it is current.
// :now is an ISO string; recert uses SQLite date arithmetic on the sign-off date.
function stateRows(db, now, hashes = currentQuizHashes(db)) {
  return db.prepare(`
  WITH trainee AS (${TRAINEES}),
  qh AS (SELECT json_extract(value,'$.m') module_id, json_extract(value,'$.h') h FROM json_each(@hashes)),
  best AS (SELECT a.user_id, a.module_id, MAX(a.score_pct) best_pct, COUNT(*) attempts, MAX(a.created_at) last_attempt
           FROM quiz_attempts a JOIN qh ON qh.module_id=a.module_id AND (a.quiz_hash IS NULL OR a.quiz_hash=qh.h)
           GROUP BY a.user_id, a.module_id),
  latest_score AS (SELECT trainee_id, skill_id, score, event_at FROM (
           SELECT p.*, ROW_NUMBER() OVER (PARTITION BY trainee_id, skill_id ORDER BY event_at DESC, rowid DESC) rn FROM practical_scores p) WHERE rn=1),
  prac AS (SELECT t.id user_id, s.module_id, COUNT(*) skills, SUM(ls.score IS NOT NULL) scored, SUM(ls.score >= @pskill) passed,
                  MAX(ls.event_at) last_scored
           FROM trainee t CROSS JOIN practical_skills s LEFT JOIN latest_score ls ON ls.trainee_id=t.id AND ls.skill_id=s.id GROUP BY t.id, s.module_id),
  so AS (SELECT s.trainee_id, s.module_id, s.created_at signed_at, s.module_version, s.signed_by, s.quiz_pct FROM signoffs s
         WHERE s.rowid = (SELECT MAX(rowid) FROM signoffs x WHERE x.trainee_id=s.trainee_id AND x.module_id=s.module_id))
  SELECT t.id user_id, t.display_name, m.id module_id, m.title, m.level, m.status module_status, m.version module_version, m.recert_months,
         (SELECT COUNT(*) FROM quiz_questions q WHERE q.module_id=m.id) questions,
         b.best_pct, COALESCE(b.attempts,0) attempts,
         COALESCE(p.skills,0) skills, COALESCE(p.scored,0) scored, COALESCE(p.passed,0) skills_passed,
         so.signed_at, so.module_version signed_version, so.signed_by, u2.display_name signed_by_name,
         CASE WHEN so.signed_at IS NULL THEN NULL WHEN m.recert_months IS NULL THEN NULL ELSE date(so.signed_at, '+'||m.recert_months||' months') END expires_on,
         COALESCE(so.signed_at, b.last_attempt, p.last_scored) IS NULL AS untouched,
         MAX(COALESCE(b.last_attempt,''), COALESCE(p.last_scored,'')) last_work
  FROM trainee t CROSS JOIN training_modules m
  LEFT JOIN best b ON b.user_id=t.id AND b.module_id=m.id
  LEFT JOIN prac p ON p.user_id=t.id AND p.module_id=m.id
  LEFT JOIN so ON so.trainee_id=t.id AND so.module_id=m.id
  LEFT JOIN users u2 ON u2.id=so.signed_by
  ORDER BY t.display_name, m.level, m.title`).all({ hashes: JSON.stringify(hashes), pskill: PASS_SKILL }).map(r => classify(r, now));
}

function classify(r, now) {
  const today = now.slice(0, 10);
  const written = r.questions === 0 ? 'no_quiz' : r.best_pct == null ? 'none' : r.best_pct >= PASS_PCT ? 'passed' : 'failed';
  const practical = r.skills === 0 ? 'no_skills' : r.scored === 0 ? 'none' : r.skills_passed === r.skills ? 'passed' : 'partial';
  let signoff = 'none';
  if (r.signed_at) {
    const stale = r.signed_version != null && r.signed_version !== r.module_version;
    const expired = r.expires_on && r.expires_on <= today;
    const soon = r.expires_on && !expired && r.expires_on <= new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10);
    signoff = stale ? 'stale' : expired ? 'expired' : soon ? 'current_due_soon' : 'current';
  }
  const eligible = signoff !== 'current' && signoff !== 'current_due_soon' && written === 'passed' && practical === 'passed' && r.module_status === 'approved';
  return { ...r, written, practical, signoff, awaiting_signoff: eligible };
}

const isCurrent = s => s === 'current' || s === 'current_due_soon';

function equipmentRisk(db) {
  const rows = db.prepare(`
    SELECT e.id, e.name, e.category, e.status, e.updated_at,
      SUM(f.provenance='verify') verify_fields, COUNT(*) fields,
      (SELECT a.override FROM equipment_approvals a WHERE a.equipment_id=e.id ORDER BY a.created_at DESC LIMIT 1) approved_with_override,
      (SELECT a.created_at FROM equipment_approvals a WHERE a.equipment_id=e.id ORDER BY a.created_at DESC LIMIT 1) approved_at
    FROM equipment e JOIN equipment_fields f ON f.equipment_id=e.id
    WHERE e.deleted_at IS NULL GROUP BY e.id HAVING verify_fields > 0 ORDER BY (e.status='approved') DESC, verify_fields DESC, e.name`).all();
  return {
    approved_with_verify: rows.filter(r => r.status === 'approved'),     // trusted-looking but not verified: the risky ones
    other_with_verify: rows.filter(r => r.status !== 'approved').length,
    counts: db.prepare(`SELECT status, COUNT(*) n FROM equipment WHERE deleted_at IS NULL GROUP BY status`).all(),
  };
}

function homeData(db, nowDate = new Date()) {
  const now = iso(nowDate), t0 = process.hrtime.bigint();
  const timings = {}; const time = (k, f) => { const s = process.hrtime.bigint(); const v = f(); timings[k] = Number(process.hrtime.bigint() - s) / 1e6; return v; };
  const state = time('state_rows', () => stateRows(db, now));
  const days = (a) => Math.floor((nowDate - new Date(a)) / 86400000);
  const reviews = time('reviews', () => ({
    equipment: db.prepare(`SELECT id,name,updated_at FROM equipment WHERE status='needs_review' AND deleted_at IS NULL ORDER BY updated_at`).all().map(r => ({ ...r, waiting_days: days(r.updated_at) })),
    modules: db.prepare(`SELECT id,title,updated_at FROM training_modules WHERE status='needs_review' ORDER BY updated_at`).all().map(r => ({ ...r, waiting_days: days(r.updated_at) })),
    panels: db.prepare(`SELECT id,title,updated_at FROM photo_panels WHERE status='needs_review' AND deleted_at IS NULL ORDER BY updated_at`).all().map(r => ({ ...r, waiting_days: days(r.updated_at) })) }));
  const risk = time('equipment_verify', () => equipmentRisk(db));
  const updates = time('updates', () => db.prepare(`SELECT u.id, e.name equipment, u.kind, u.available_version, u.status, u.created_at, u.status_at, p.display_name status_by
      FROM equipment_updates u JOIN equipment e ON e.id=u.equipment_id LEFT JOIN users p ON p.id=u.status_by ORDER BY u.created_at`).all().map(r => ({ ...r, age_days: days(r.created_at) })));
  const issues = time('issues', () => db.prepare(`SELECT i.id,i.title,i.created_at,e.name equipment,u.display_name raised_by FROM issues i LEFT JOIN equipment e ON e.id=i.equipment_id JOIN users u ON u.id=i.created_by
      WHERE i.kind='issue' AND i.status='open' ORDER BY i.created_at`).all().map(r => ({ ...r, age_days: days(r.created_at) })));
  const inactive = time('no_activity', () => db.prepare(`
    WITH tr AS (${TRAINEES}),
    last AS (SELECT t.id, t.display_name, t.role_name, t.created_at,
       MAX(COALESCE(t.last_login_at,''), COALESCE((SELECT MAX(created_at) FROM quiz_attempts WHERE user_id=t.id),''),
           COALESCE((SELECT MAX(created_at) FROM practical_scores WHERE trainee_id=t.id),''), COALESCE((SELECT MAX(created_at) FROM issues WHERE created_by=t.id),'')) last_activity FROM tr t)
    SELECT * FROM last WHERE last_activity < @cut ORDER BY last_activity`).all({ cut: iso(new Date(nowDate - 30 * 86400000)) })
    .map(r => ({ ...r, last_activity: r.last_activity || null, days_inactive: r.last_activity ? days(r.last_activity) : null, never_active: !r.last_activity })));
  const people = {};
  for (const r of state) (people[r.user_id] ||= { id: r.user_id, name: r.display_name, rows: [] }).rows.push(r);
  const stale = state.filter(r => r.signoff === 'stale'), expired = state.filter(r => r.signoff === 'expired'), soon = state.filter(r => r.signoff === 'current_due_soon');
  const waiting = state.filter(r => r.awaiting_signoff && r.signoff === 'none');
  const slim = r => ({ person: r.display_name, user_id: r.user_id, module: r.title, module_id: r.module_id, signed_version: r.signed_version, current_version: r.module_version, signed_at: r.signed_at, signed_by: r.signed_by_name, expires_on: r.expires_on });
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    generated_at: now,
    needs_attention: {
      reviews_waiting: { total: reviews.equipment.length + reviews.modules.length + reviews.panels.length, ...reviews },
      stale_signoffs: { total: stale.length, people_affected: new Set(stale.map(r => r.user_id)).size, items: stale.map(slim) },
      recert: { overdue: expired.length, due_in_30_days: soon.length, overdue_items: expired.map(slim), due_soon_items: soon.map(slim) },
      awaiting_signoff: { total: waiting.length, items: waiting.map(r => ({ person: r.display_name, module: r.title, quiz_pct: r.best_pct })) },
      equipment_verify: { approved_with_verify: risk.approved_with_verify.length, of_which_override: risk.approved_with_verify.filter(r => r.approved_with_override).length, items: risk.approved_with_verify.slice(0, 10), counts: risk.counts, other_status_with_verify: risk.other_with_verify },
      updates_not_installed: { total: updates.filter(u => u.status === 'available' || u.status === 'scheduled').length,
        available: updates.filter(u => u.status === 'available').reverse(), scheduled: updates.filter(u => u.status === 'scheduled'),
        recently_installed: updates.filter(u => u.status === 'installed_by_human').sort((a, b) => b.status_at.localeCompare(a.status_at)).slice(0, 5) },
      open_issues: { total: issues.length, oldest_days: issues.length ? issues[0].age_days : null, items: issues },
      no_activity_30d: { total: inactive.length, people: inactive },
    },
    timings_ms: { ...timings, total },
  };
}

function readiness(db, profileId, nowDate = new Date()) {
  const now = iso(nowDate), state = stateRows(db, now);
  const profs = profileId ? db.prepare('SELECT * FROM readiness_profiles WHERE id=? OR name=?').all(profileId, profileId) : db.prepare('SELECT * FROM readiness_profiles ORDER BY name').all();
  return profs.map(p => {
    const mods = db.prepare('SELECT m.id,m.title,m.level FROM readiness_profile_modules x JOIN training_modules m ON m.id=x.module_id WHERE x.profile_id=? ORDER BY m.level,m.title').all(p.id);
    const by = {}; for (const r of state) (by[r.user_id] ||= { id: r.user_id, name: r.display_name, mods: {} }).mods[r.module_id] = r;
    const people = Object.values(by).map(u => {
      const cells = mods.map(m => { const r = u.mods[m.id]; return { module: m.title, written: r.written, best_pct: r.best_pct, practical: r.practical, skills: `${r.skills_passed}/${r.skills}`, signoff: r.signoff, signed_at: r.signed_at, expires_on: r.expires_on, awaiting_signoff: r.awaiting_signoff }; });
      const blockers = cells.filter(c => !isCurrent(c.signoff));
      return { id: u.id, name: u.name, ready: blockers.length === 0, steps_to_ready: blockers.length, blockers: blockers.map(c => `${c.module}: ${c.signoff === 'none' ? (c.awaiting_signoff ? 'passed, awaiting sign-off' : `written ${c.written}, practical ${c.practical}`) : c.signoff}`), cells };
    }).sort((a, b) => a.steps_to_ready - b.steps_to_ready || a.name.localeCompare(b.name));
    return { id: p.id, name: p.name, description: p.description, modules: mods, ready_count: people.filter(x => x.ready).length, people };
  });
}

function debrief(db, from, to) {
  const rows = db.prepare(`SELECT i.id,i.kind,i.status,i.title,i.event_name,i.event_date,i.created_at,e.name equipment,u.display_name author FROM issues i LEFT JOIN equipment e ON e.id=i.equipment_id JOIN users u ON u.id=i.created_by
    WHERE COALESCE(i.event_date, substr(i.created_at,1,10)) BETWEEN @from AND @to ORDER BY COALESCE(i.event_date, substr(i.created_at,1,10)) DESC, i.kind DESC`).all({ from, to });
  const events = {}; for (const r of rows) (events[r.event_name || '(no event tagged)'] ||= { name: r.event_name || '(no event tagged)', date: r.event_date, lessons: [], issues: [] })[r.kind === 'lesson' ? 'lessons' : 'issues'].push(r);
  const repeated = db.prepare(`SELECT e.name equipment, COUNT(*) n, COUNT(DISTINCT i.event_name) events FROM issues i JOIN equipment e ON e.id=i.equipment_id
    WHERE COALESCE(i.event_date, substr(i.created_at,1,10)) BETWEEN @from AND @to GROUP BY e.id HAVING n>=2 ORDER BY n DESC, e.name`).all({ from, to });
  return { from, to, events: Object.values(events), repeated_equipment: repeated };
}

module.exports = { stateRows, homeData, readiness, debrief, equipmentRisk, currentQuizHashes, isCurrent, PASS_PCT, PASS_SKILL };
