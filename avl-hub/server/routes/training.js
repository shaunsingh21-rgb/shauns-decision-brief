'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, parse } = require('../lib/validate');
const { editTime, superseded } = require('../lib/sync');

const PASS_PCT = 80, PASS_SKILL = 2;

module.exports = function trainingRoutes(api, ctx) {
  const { P } = api;
  const { db, audit } = ctx;
  const now = () => new Date().toISOString();
  const isTrainee = uid => { const u = db.prepare('SELECT role FROM users WHERE id=? AND disabled=0').get(uid); return !!u && ctx.roles.permissionsOf(u.role).has('training.take'); };
  const mod = mid => { const m = db.prepare('SELECT * FROM training_modules WHERE id=?').get(mid); if (!m) throw new HttpError(404, 'NOT_FOUND', 'Module not found.'); return m; };
  // Editing approved material returns it to Needs Review.
  const touch = (req, m) => db.prepare(`UPDATE training_modules SET status=CASE WHEN status='approved' THEN 'needs_review' ELSE status END,
    version=version+1, updated_by=?, updated_at=? WHERE id=?`).run(req.user.id, now(), m.id);

  // Written and practical progress are computed separately, never merged into one number.
  function progress(userId, moduleId) {
    const best = db.prepare('SELECT MAX(score_pct) p FROM quiz_attempts WHERE user_id=? AND module_id=?').get(userId, moduleId).p;
    const skills = db.prepare(`
      SELECT s.id skill_id, s.name, (SELECT score FROM practical_scores p WHERE p.trainee_id=? AND p.skill_id=s.id ORDER BY p.rowid DESC LIMIT 1) score
      FROM practical_skills s WHERE s.module_id=? ORDER BY s.rowid`).all(userId, moduleId);
    const questions = db.prepare('SELECT COUNT(*) n FROM quiz_questions WHERE module_id=?').get(moduleId).n;
    const so = db.prepare('SELECT signed_by,created_at FROM signoffs WHERE trainee_id=? AND module_id=?').get(userId, moduleId);
    return {
      module_id: moduleId,
      written: { has_quiz: questions > 0, best_pct: best, passed: best !== null && best >= PASS_PCT, pass_pct: PASS_PCT },
      practical: { skills, pass_score: PASS_SKILL, has_skills: skills.length > 0,
        passed: skills.length > 0 && skills.every(s => s.score !== null && s.score >= PASS_SKILL) },
      signed_off: so ? { by: so.signed_by, at: so.created_at } : null,
    };
  }

  api.get('/modules', 'any', async (_req, res) => res.json({ modules: db.prepare(
    `SELECT m.id,m.title,m.level,m.equipment_id,m.summary,m.status,m.version,
       (SELECT COUNT(*) FROM quiz_questions q WHERE q.module_id=m.id) questions,
       (SELECT COUNT(*) FROM practical_skills s WHERE s.module_id=m.id) skills
     FROM training_modules m ORDER BY m.level,m.title`).all() }));

  api.get('/modules/:id', 'any', async (req, res) => {
    const m = mod(parse(id, req.params.id));
    const author = req.permissions.has('training.author');
    m.skills = db.prepare('SELECT id,name FROM practical_skills WHERE module_id=? ORDER BY rowid').all(m.id);
    m.quiz = db.prepare('SELECT id,prompt,options,correct_index FROM quiz_questions WHERE module_id=? ORDER BY rowid').all(m.id)
      .map(q => ({ id: q.id, prompt: q.prompt, options: JSON.parse(q.options), ...(author ? { correct_index: q.correct_index } : {}) })); // learners never see answers
    res.json({ module: m });
  });

  api.post('/modules', P('training.author'), async (req, res) => {
    const b = parse(z.object({ title: text(120, 1), level: z.number().int().min(1).max(5), summary: text(2000).optional(), equipment_id: id.optional() }).strict(), req.body);
    if (b.equipment_id && !db.prepare('SELECT 1 FROM equipment WHERE id=? AND deleted_at IS NULL').get(b.equipment_id)) throw new HttpError(400, 'BAD_EQUIPMENT', 'Unknown equipment.');
    const mid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(`INSERT INTO training_modules (id,title,level,equipment_id,summary,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(mid, b.title, b.level, b.equipment_id || null, b.summary || '', req.user.id, req.user.id, now(), now());
      audit(req, 'module.create', 'module', mid, { title: b.title, level: b.level });
    })();
    res.status(201).json({ module: mod(mid) });
  });

  api.patch('/modules/:id', P('training.author'), async (req, res) => {
    const m = mod(parse(id, req.params.id));
    const b = parse(z.object({ title: text(120, 1).optional(), level: z.number().int().min(1).max(5).optional(), summary: text(2000).optional() }).strict(), req.body);
    const at = editTime(req);
    if (superseded(m.edit_at, at)) {
      db.transaction(() => audit(req, 'sync.superseded', 'module', m.id, { edit_time: at, current_edit_at: m.edit_at }))();
      return res.json({ applied: false, superseded: true, module: mod(m.id) });
    }
    db.transaction(() => {
      db.prepare('UPDATE training_modules SET title=?,level=?,summary=?,edit_at=? WHERE id=?').run(b.title ?? m.title, b.level ?? m.level, b.summary ?? m.summary, at, m.id);
      touch(req, m);
      audit(req, 'module.update', 'module', m.id, { status_change: m.status === 'approved' ? 'approved->needs_review' : undefined });
    })();
    res.json({ module: mod(m.id) });
  });

  api.post('/modules/:id/submit-review', P('training.author'), async (req, res) => {
    const m = mod(parse(id, req.params.id));
    if (m.status === 'approved') throw new HttpError(409, 'ALREADY_APPROVED', 'Already approved.');
    db.transaction(() => {
      db.prepare("UPDATE training_modules SET status='needs_review',version=version+1,updated_by=?,updated_at=? WHERE id=?").run(req.user.id, now(), m.id);
      audit(req, 'module.submit_review', 'module', m.id);
    })();
    res.json({ module: mod(m.id) });
  });

  api.post('/modules/:id/approve', P('training.approve'), async (req, res) => {
    const m = mod(parse(id, req.params.id));
    const rv = parse(z.object({ reviewed_version: z.number().int().optional() }).strict(), req.body);
    if (rv.reviewed_version !== undefined && rv.reviewed_version !== m.version) throw new HttpError(409, 'STALE_REVIEW', 'This material changed after you reviewed it. Review the latest version, then approve again.', { current_version: m.version });
    if (m.status === 'approved') throw new HttpError(409, 'ALREADY_APPROVED', 'Already approved.');
    db.transaction(() => {
      db.prepare("UPDATE training_modules SET status='approved',version=version+1,updated_by=?,updated_at=? WHERE id=?").run(req.user.id, now(), m.id);
      audit(req, 'module.approve', 'module', m.id);
    })();
    res.json({ module: mod(m.id) });
  });

  api.post('/modules/:id/questions', P('training.author'), async (req, res) => {
    const m = mod(parse(id, req.params.id));
    const b = parse(z.object({ prompt: text(500, 1), options: z.array(text(200, 1)).min(2).max(6), correct_index: z.number().int().min(0) }).strict(), req.body);
    if (b.correct_index >= b.options.length) throw new HttpError(400, 'VALIDATION', 'correct_index out of range.');
    const qid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO quiz_questions VALUES (?,?,?,?,?)').run(qid, m.id, b.prompt, JSON.stringify(b.options), b.correct_index);
      touch(req, m); audit(req, 'quiz.add_question', 'module', m.id, { question_id: qid });
    })();
    res.status(201).json({ id: qid });
  });
  api.delete('/questions/:id', P('training.author'), async (req, res) => {
    const q = db.prepare('SELECT * FROM quiz_questions WHERE id=?').get(parse(id, req.params.id));
    if (!q) throw new HttpError(404, 'NOT_FOUND', 'Question not found.');
    db.transaction(() => {
      db.prepare('DELETE FROM quiz_questions WHERE id=?').run(q.id);
      touch(req, mod(q.module_id)); audit(req, 'quiz.remove_question', 'module', q.module_id, { question_id: q.id });
    })();
    res.json({ ok: true });
  });

  api.post('/modules/:id/skills', P('training.author'), async (req, res) => {
    const m = mod(parse(id, req.params.id));
    const b = parse(z.object({ name: text(120, 1) }).strict(), req.body);
    const sid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO practical_skills VALUES (?,?,?)').run(sid, m.id, b.name);
      touch(req, m); audit(req, 'skill.add', 'module', m.id, { skill_id: sid, name: b.name });
    })();
    res.status(201).json({ id: sid });
  });
  api.delete('/skills/:id', P('training.author'), async (req, res) => {
    const s = db.prepare('SELECT * FROM practical_skills WHERE id=?').get(parse(id, req.params.id));
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Skill not found.');
    if (db.prepare('SELECT 1 FROM practical_scores WHERE skill_id=?').get(s.id)) throw new HttpError(409, 'HAS_SCORES', 'This skill already has recorded scores and cannot be removed.');
    db.transaction(() => {
      db.prepare('DELETE FROM practical_skills WHERE id=?').run(s.id);
      touch(req, mod(s.module_id)); audit(req, 'skill.remove', 'module', s.module_id, { skill_id: s.id });
    })();
    res.json({ ok: true });
  });

  // Quiz is graded on the server. The attempt is attributed to the signed-in user, never to a client-supplied id.
  api.post('/modules/:id/quiz-attempts', P('training.take'), async (req, res) => {
    const m = mod(parse(id, req.params.id));
    const b = parse(z.object({ answers: z.record(id, z.number().int().min(0).max(5)) }).strict(), req.body);
    const qs = db.prepare('SELECT id,correct_index FROM quiz_questions WHERE module_id=?').all(m.id);
    if (!qs.length) throw new HttpError(409, 'NO_QUIZ', 'This module has no quiz yet.');
    const correct = qs.filter(q => b.answers[q.id] === q.correct_index).length;
    const pct = Math.round(correct / qs.length * 100), passed = pct >= PASS_PCT;
    db.transaction(() => {
      db.prepare('INSERT INTO quiz_attempts VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), req.user.id, m.id, pct, +passed, now());
      audit(req, 'quiz.attempt', 'module', m.id, { score_pct: pct, passed });
    })();
    res.status(201).json({ score_pct: pct, passed, correct, total: qs.length, pass_pct: PASS_PCT });
  });

  // Practical rubric 0-3, scored by a trainer; the trainer cannot score themselves.
  api.post('/practical-scores', P('training.score'), async (req, res) => {
    const b = parse(z.object({ trainee_id: id, skill_id: id, score: z.number().int().min(0).max(3), note: text(500).optional() }).strict(), req.body);
    if (b.trainee_id === req.user.id) throw new HttpError(403, 'SELF_SCORING', 'You cannot score your own practical.');
    if (!isTrainee(b.trainee_id)) throw new HttpError(400, 'BAD_TRAINEE', 'That person is not a trainee (their role cannot take training).');
    const s = db.prepare('SELECT * FROM practical_skills WHERE id=?').get(b.skill_id);
    if (!s) throw new HttpError(400, 'BAD_SKILL', 'Unknown skill.');
    const pid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO practical_scores VALUES (?,?,?,?,?,?,?)').run(pid, b.trainee_id, b.skill_id, b.score, req.user.id, b.note || null, now());
      audit(req, 'practical.score', 'module', s.module_id, { trainee_id: b.trainee_id, skill_id: b.skill_id, score: b.score });
    })();
    res.status(201).json({ id: pid });
  });

  // Sign-off: quiz >= 80%, every practical skill >= 2, never your own. Append-only, attributed to the session user.
  api.post('/signoffs', P('training.signoff'), async (req, res) => {
    const b = parse(z.object({ trainee_id: id, module_id: id, note: text(500).optional() }).strict(), req.body);
    if (b.trainee_id === req.user.id) throw new HttpError(403, 'SELF_SIGNOFF', 'You cannot sign off your own training.');
    if (!isTrainee(b.trainee_id)) throw new HttpError(400, 'BAD_TRAINEE', 'That person is not a trainee (their role cannot take training).');
    const sm = mod(b.module_id);
    // Nobody is signed off against material that has not been approved (or that changed after approval and awaits review).
    if (sm.status !== 'approved') throw new HttpError(409, 'MODULE_NOT_APPROVED', `This module is ${sm.status === 'needs_review' ? 'waiting for review' : 'still a draft'}. It must be approved before anyone can be signed off on it.`);
    const p = progress(b.trainee_id, b.module_id);
    const missing = [];
    if (!p.written.has_quiz) missing.push('This module has no quiz.');
    else if (!p.written.passed) missing.push(`Written: best quiz score is ${p.written.best_pct ?? 'none'}%, needs ${PASS_PCT}%.`);
    if (!p.practical.has_skills) missing.push('This module has no practical skills defined.');
    else p.practical.skills.filter(s => s.score === null || s.score < PASS_SKILL).forEach(s => missing.push(`Practical: "${s.name}" is ${s.score ?? 'unscored'}, needs ${PASS_SKILL}+.`));
    if (missing.length) throw new HttpError(409, 'REQUIREMENTS_NOT_MET', 'Sign-off requirements are not met.', { missing });
    if (p.signed_off) throw new HttpError(409, 'ALREADY_SIGNED_OFF', 'Already signed off.');
    const sid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO signoffs VALUES (?,?,?,?,?,?,?)').run(sid, b.trainee_id, b.module_id, req.user.id, p.written.best_pct, b.note || null, now());
      audit(req, 'signoff.create', 'module', b.module_id, { trainee_id: b.trainee_id, quiz_pct: p.written.best_pct });
    })();
    res.status(201).json({ id: sid });
  });

  api.get('/progress/:userId', 'any', async (req, res) => {
    const uid = parse(id, req.params.userId);
    if (uid !== req.user.id && !req.permissions.has('progress.view_all')) throw new HttpError(403, 'FORBIDDEN', 'You can only view your own progress.');
    const mods = db.prepare('SELECT id,title,level FROM training_modules ORDER BY level,title').all();
    res.json({ progress: mods.map(m => ({ title: m.title, level: m.level, ...progress(uid, m.id) })) });
  });

  api.get('/skill-matrix', 'any', async (_req, res) => {
    const users = db.prepare('SELECT id,display_name,role FROM users WHERE disabled=0 ORDER BY display_name').all().filter(u => ctx.roles.permissionsOf(u.role).has('training.take'))
      .map(u => ({ id: u.id, display_name: u.display_name, role_name: (ctx.roles.get(u.role) || {}).name || u.role }));
    const skills = db.prepare(`SELECT s.id,s.name,m.id module_id,m.title module_title,m.level FROM practical_skills s JOIN training_modules m ON m.id=s.module_id ORDER BY m.level,m.title,s.rowid`).all();
    const scores = {};
    for (const r of db.prepare(`SELECT trainee_id,skill_id,score FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY trainee_id,skill_id ORDER BY rowid DESC) rn FROM practical_scores) WHERE rn=1`).all())
      (scores[r.trainee_id] ||= {})[r.skill_id] = r.score;
    res.json({ users, skills, scores, signoffs: db.prepare('SELECT trainee_id,module_id FROM signoffs').all() });
  });
};
