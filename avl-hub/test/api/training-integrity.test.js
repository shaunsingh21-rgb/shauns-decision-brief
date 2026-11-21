'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('../helpers');

let h, ac, tc, t2c, kc, kc2, vc, tech, tech2, trainer, mod, qids, skill;
const T = ms => new Date(Date.now() + ms).toISOString();
before(async () => {
  h = await harness({ quizAttemptsPerHour: 4 });
  const admin = await h.makeUser('admin'); trainer = await h.makeUser('trainer'); const trainer2 = await h.makeUser('trainer'); tech = await h.makeUser('technician', 'alex'); tech2 = await h.makeUser('technician', 'blair');
  [ac, tc, t2c, kc, kc2, vc] = [await h.as(admin), await h.as(trainer), await h.as(trainer2), await h.as(tech), await h.as(tech2), await h.as(await h.makeUser('viewer'))];
});
after(() => h.close());
async function freshModule(title = 'SAMPLE integrity') {
  const m = (await tc.post('/api/modules', { title, level: 1 })).body.module;
  const q = []; for (let i = 0; i < 5; i++) q.push((await tc.post(`/api/modules/${m.id}/questions`, { prompt: `SAMPLE q${i}`, options: ['a', 'b', 'c'], correct_index: 1 })).body.id);
  const s = (await tc.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE skill' })).body.id; await ac.post(`/api/modules/${m.id}/approve`);
  return { m, q, s };
}
const all = (q, n) => Object.fromEntries(q.map((id, i) => [id, i < n ? 1 : 0]));

test('QUIZ ORACLE CLOSED: every question must be answered, only a percentage comes back, and attempts are limited', async () => {
  const { m, q } = await freshModule();
  const one = await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: { [q[0]]: 1 } });
  assert.equal(one.status, 400); assert.equal(one.body.error.code, 'ANSWER_ALL'); assert.match(one.body.error.message, /4 are still blank/);
  assert.equal((await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: {} })).body.error.code, 'ANSWER_ALL');
  const r = await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: all(q, 3) });
  assert.equal(r.status, 201); assert.deepEqual(Object.keys(r.body).sort(), ['pass_pct', 'passed', 'score_pct'], 'no correct/total counts that would reveal which answers were right');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM quiz_attempts WHERE module_id=?').get(m.id).n, 1, 'rejected attempts are not recorded');
  for (let i = 0; i < 3; i++) assert.equal((await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: all(q, i) })).status, 201);
  const capped = await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: all(q, 5) });                  // the limit in this test is 4 per hour
  assert.equal(capped.status, 429); assert.equal(capped.body.error.code, 'TOO_MANY_ATTEMPTS'); assert.match(capped.body.error.message, /4 attempts.*try again in \d+ minute/);
  assert.equal((await kc2.post(`/api/modules/${m.id}/quiz-attempts`, { answers: all(q, 5) })).status, 201, 'the limit is per person');
});

test('a quiz score belongs to the quiz it was taken against: replacing the questions starts the written requirement afresh', async () => {
  const { m, q } = await freshModule('SAMPLE replace quiz');
  await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: all(q, 5) });
  assert.equal((await kc.get(`/api/progress/${tech.id}`)).body.progress.find(p => p.module_id === m.id).written.best_pct, 100);
  for (const id of q) await tc.del(`/api/questions/${id}`);
  const nq = (await tc.post(`/api/modules/${m.id}/questions`, { prompt: 'SAMPLE new question', options: ['x', 'y'], correct_index: 0 })).body.id;
  const w = (await kc.get(`/api/progress/${tech.id}`)).body.progress.find(p => p.module_id === m.id).written;
  assert.deepEqual([w.best_pct, w.passed], [null, false], 'the old 100% does not count for the new quiz');
  await ac.post(`/api/modules/${m.id}/approve`); await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: { [nq]: 0 } });
  assert.equal((await kc.get(`/api/progress/${tech.id}`)).body.progress.find(p => p.module_id === m.id).written.passed, true);
});

test('SIGN-OFF HISTORY: it records the version and scores, shows when the material changed since, and can be renewed (never overwritten)', async () => {
  const { m, q, s } = await freshModule('SAMPLE history');
  await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: all(q, 5) }); await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: s, score: 3 });
  const v1 = (await tc.get(`/api/modules/${m.id}`)).body.module.version;
  const so = await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id, note: 'SAMPLE: solid on the console' }); assert.equal(so.status, 201);
  const row = h.db.prepare('SELECT * FROM signoffs WHERE id=?').get(so.body.id);
  assert.equal(row.module_version, v1); assert.deepEqual(JSON.parse(row.scores), [{ skill: 'SAMPLE skill', score: 3 }]); assert.equal(row.note, 'SAMPLE: solid on the console');
  let p = (await kc.get(`/api/progress/${tech.id}`)).body.progress.find(x => x.module_id === m.id).signed_off; assert.deepEqual([p.module_version, p.stale], [v1, false]);
  const audit = JSON.parse((await ac.get('/api/audit?limit=20')).body.entries.find(e => e.action === 'signoff.create').detail);
  assert.deepEqual([audit.trainee, audit.module, audit.module_version, audit.note], ['Sample alex', 'SAMPLE history', v1, 'SAMPLE: solid on the console']); assert.deepEqual(audit.scores, [{ skill: 'SAMPLE skill', score: 3 }]);
  assert.equal((await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id })).body.error.code, 'ALREADY_SIGNED_OFF', 'same version: no duplicate');

  await tc.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE added later' }); await ac.post(`/api/modules/${m.id}/approve`);        // the material changes and is re-approved
  p = (await kc.get(`/api/progress/${tech.id}`)).body.progress.find(x => x.module_id === m.id); assert.equal(p.signed_off.stale, true, 'the sign-off is shown as out of date');
  assert.equal(p.practical.passed, false, 'and the trainee no longer meets the current requirements');
  assert.equal((await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id })).body.error.code, 'REQUIREMENTS_NOT_MET', 'renewal needs the rules met again');
  const added = (await tc.get(`/api/modules/${m.id}`)).body.module.skills.find(x => x.name === 'SAMPLE added later');
  await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: added.id, score: 2 });
  const renew = await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id }); assert.equal(renew.status, 201, JSON.stringify(renew.body));
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM signoffs WHERE trainee_id=? AND module_id=?').get(tech.id, m.id).n, 2, 'history kept: the first sign-off is still on record');
  assert.equal((await kc.get(`/api/progress/${tech.id}`)).body.progress.find(x => x.module_id === m.id).signed_off.stale, false);
  assert.equal(JSON.parse((await ac.get('/api/audit?limit=20')).body.entries.find(e => e.action === 'signoff.create').detail).renewal, true);
  assert.throws(() => h.db.prepare('UPDATE signoffs SET quiz_pct=1').run(), /append-only/); assert.throws(() => h.db.prepare('DELETE FROM signoffs').run(), /append-only/);
});

test('the sign-off messages say what to DO', async () => {
  const m = (await tc.post('/api/modules', { title: 'SAMPLE bare', level: 2 })).body.module; await ac.post(`/api/modules/${m.id}/approve`);
  const r = await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id }); assert.equal(r.status, 409);
  assert.ok(r.body.error.missing.some(x => /no quiz yet.*Add at least one question/.test(x))); assert.ok(r.body.error.missing.some(x => /no practical skills yet.*Add at least one skill/.test(x)));
  const f = await freshModule('SAMPLE untaken'); const u = await t2c.post('/api/signoffs', { trainee_id: tech2.id, module_id: f.m.id });
  assert.ok(u.body.error.missing.some(x => /no quiz taken yet \(80% needed\)/.test(x)), JSON.stringify(u.body.error.missing)); assert.ok(!u.body.error.missing.some(x => /none%/.test(x)));
});

test('re-scoring someone who is already signed off below the pass mark is allowed but flagged', async () => {
  const { m, q, s } = await freshModule('SAMPLE rescore'); await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: all(q, 5) });
  await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: s, score: 3 }); await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id });
  const low = await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: s, score: 0 }); assert.equal(low.status, 201); assert.equal(low.body.signed_off_warning, true);
  assert.equal((await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: s, score: 3 })).body.signed_off_warning, false);
  assert.equal((await tc.post('/api/practical-scores', { trainee_id: tech2.id, skill_id: s, score: 0 })).body.signed_off_warning, false, 'not signed off: nothing to warn about');
});

test('practical scores are ordered by WHEN THEY WERE GIVEN, not when they arrived (an older offline score cannot override a newer one)', async () => {
  const { m, s } = await freshModule('SAMPLE ordering');
  await tc.req('POST', '/api/practical-scores', { trainee_id: tech.id, skill_id: s, score: 1 }, { headers: { 'x-edit-time': T(-60e3) } });                // given a minute ago, arrives first
  await t2c.req('POST', '/api/practical-scores', { trainee_id: tech.id, skill_id: s, score: 3 }, { headers: { 'x-edit-time': T(-3600e3) } });           // given an HOUR ago, but arrives later
  const sk = (await kc.get(`/api/progress/${tech.id}`)).body.progress.find(p => p.module_id === m.id).practical.skills[0];
  assert.equal(sk.score, 1, 'the later-given score (1) stands, even though the older one (3) arrived last');
  const matrix = (await ac.get('/api/skill-matrix')).body; assert.equal(matrix.scores[tech.id][s], 1, 'the matrix agrees');
});

test('the skill matrix follows "see everyone\'s progress": without it you see only your own row', async () => {
  const { s } = await freshModule('SAMPLE matrix'); await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: s, score: 2 }); await tc.post('/api/practical-scores', { trainee_id: tech2.id, skill_id: s, score: 3 });
  const mine = (await kc.get('/api/skill-matrix')).body; assert.deepEqual(mine.users.map(u => u.id), [tech.id]); assert.deepEqual(Object.keys(mine.scores), [tech.id]); assert.ok(mine.signoffs.every(x => x.trainee_id === tech.id));
  const everyone = (await tc.get('/api/skill-matrix')).body; assert.ok(everyone.users.length >= 3); assert.ok(everyone.scores[tech2.id]);
  const viewer = (await vc.get('/api/skill-matrix')).body; assert.deepEqual(viewer.users, []); assert.deepEqual(viewer.scores, {}); assert.deepEqual(viewer.signoffs, []);
});
