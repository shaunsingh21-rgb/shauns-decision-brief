'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('../helpers');

let h, admin, trainer, trainer2, tech, ac, tc, t2c, kc, mod, qids, skills;
before(async () => {
  h = await harness();
  [admin, trainer, trainer2, tech] = [await h.makeUser('admin'), await h.makeUser('trainer'), await h.makeUser('trainer'), await h.makeUser('technician')];
  [ac, tc, t2c, kc] = [await h.as(admin), await h.as(trainer), await h.as(trainer2), await h.as(tech)];
  // SAMPLE module (labelled sample data, no manufacturer specs)
  mod = (await tc.post('/api/modules', { title: 'SAMPLE: Level 1 Signal Flow Basics', level: 1 })).body.module;
  qids = [];
  for (let i = 0; i < 5; i++) qids.push((await tc.post(`/api/modules/${mod.id}/questions`, { prompt: `SAMPLE question ${i}`, options: ['A', 'B', 'C'], correct_index: 1 })).body.id);
  skills = [];
  for (const n of ['SAMPLE skill one', 'SAMPLE skill two']) skills.push((await tc.post(`/api/modules/${mod.id}/skills`, { name: n })).body.id);
  await ac.post(`/api/modules/${mod.id}/approve`);                        // sign-off requires approved material
});
after(() => h.close());
const answers = (nCorrect) => Object.fromEntries(qids.map((q, i) => [q, i < nCorrect ? 1 : 0]));

test('learners never receive correct answers; trainers do', async () => {
  const t = (await kc.get(`/api/modules/${mod.id}`)).body.module;
  assert.equal(t.quiz.length, 5); assert.ok(t.quiz.every(q => !('correct_index' in q)));
  assert.ok((await tc.get(`/api/modules/${mod.id}`)).body.module.quiz.every(q => 'correct_index' in q));
});

test('a trainer cannot sign off themselves, and cannot score their own practical', async () => {
  const r = await tc.post('/api/signoffs', { trainee_id: trainer.id, module_id: mod.id });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'SELF_SIGNOFF');
  assert.equal((await ac.post('/api/signoffs', { trainee_id: admin.id, module_id: mod.id })).status, 403);
  assert.equal((await tc.post('/api/practical-scores', { trainee_id: trainer.id, skill_id: skills[0], score: 3 })).status, 403);
});

test('a technician cannot sign anyone off (including themselves)', async () => {
  assert.equal((await kc.post('/api/signoffs', { trainee_id: tech.id, module_id: mod.id })).status, 403);
});

test('sign-off is blocked until quiz >= 80% AND every skill >= 2; progress is tracked separately', async () => {
  let r = await tc.post('/api/signoffs', { trainee_id: tech.id, module_id: mod.id });
  assert.equal(r.status, 409); assert.equal(r.body.error.missing.length, 3);

  const fail = (await kc.post(`/api/modules/${mod.id}/quiz-attempts`, { answers: answers(3) })).body;   // 60%
  assert.deepEqual([fail.score_pct, fail.passed], [60, false]);
  const pass = (await kc.post(`/api/modules/${mod.id}/quiz-attempts`, { answers: answers(4) })).body;   // 80% exactly passes
  assert.deepEqual([pass.score_pct, pass.passed], [80, true]);

  let p = (await kc.get(`/api/progress/${tech.id}`)).body.progress[0];
  assert.equal(p.written.passed, true); assert.equal(p.practical.passed, false);   // separate

  await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: skills[0], score: 3 });
  await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: skills[1], score: 1 });
  r = await tc.post('/api/signoffs', { trainee_id: tech.id, module_id: mod.id });
  assert.equal(r.status, 409); assert.match(r.body.error.missing[0], /skill two.*1/);

  await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: skills[1], score: 2 });   // latest score counts
  p = (await kc.get(`/api/progress/${tech.id}`)).body.progress[0];
  assert.equal(p.practical.passed, true); assert.equal(p.signed_off, null);

  r = await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: mod.id, note: 'SAMPLE sign-off' });
  assert.equal(r.status, 201);
  assert.equal((await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: mod.id })).status, 409);
  const row = h.db.prepare('SELECT signed_by FROM signoffs').get();
  assert.equal(row.signed_by, trainer2.id, 'attributed to the signed-in user');
});

test('sign-off client cannot spoof the signer', async () => {
  const r = await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: mod.id, signed_by: admin.id });
  assert.equal(r.status, 400);
});

test('sign-offs and audit entries are append-only at the database level', () => {
  assert.throws(() => h.db.prepare('UPDATE signoffs SET quiz_pct=100').run(), /append-only/);
  assert.throws(() => h.db.prepare('DELETE FROM signoffs').run(), /append-only/);
  assert.throws(() => h.db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.throws(() => h.db.prepare('UPDATE audit_log SET action=1').run(), /append-only/);
  assert.throws(() => h.db.prepare('INSERT INTO signoffs VALUES (?,?,?,?,?,?,?)').run('x', admin.id, mod.id, admin.id, 90, null, 'now'), /constraint|CHECK/i);
});

test('editing approved training material returns it to Needs Review', async () => {
  assert.equal((await tc.post(`/api/modules/${mod.id}/approve`)).status, 403, 'trainers cannot approve');
  const r = await tc.patch(`/api/modules/${mod.id}`, { summary: 'SAMPLE edit' });
  assert.equal(r.body.module.status, 'needs_review');
});

test('sign-off is refused unless the module is Approved: drafts, and approved modules edited since, both block it', async () => {
  const m = (await tc.post('/api/modules', { title: 'SAMPLE draft module', level: 1 })).body.module;
  const q = (await tc.post(`/api/modules/${m.id}/questions`, { prompt: 'SAMPLE q', options: ['a', 'b'], correct_index: 1 })).body.id;
  const sk = (await tc.post(`/api/modules/${m.id}/skills`, { name: 'SAMPLE skill' })).body.id;
  await kc.post(`/api/modules/${m.id}/quiz-attempts`, { answers: { [q]: 1 } }); await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: sk, score: 3 });
  const draft = await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id });
  assert.equal(draft.status, 409); assert.equal(draft.body.error.code, 'MODULE_NOT_APPROVED'); assert.match(draft.body.error.message, /still a draft/);
  await tc.post(`/api/modules/${m.id}/submit-review`);
  assert.match((await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id })).body.error.message, /waiting for review/);
  await ac.post(`/api/modules/${m.id}/approve`);
  await tc.patch(`/api/modules/${m.id}`, { summary: 'SAMPLE changed after approval' });                       // back to Needs Review
  assert.equal((await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id })).body.error.code, 'MODULE_NOT_APPROVED');
  await ac.post(`/api/modules/${m.id}/approve`);
  assert.equal((await t2c.post('/api/signoffs', { trainee_id: tech.id, module_id: m.id })).status, 201, 'allowed once approved');
});

test('progress of other people is private to learners; trainers can view', async () => {
  assert.equal((await kc.get(`/api/progress/${trainer.id}`)).status, 403);
  assert.equal((await tc.get(`/api/progress/${tech.id}`)).status, 200);
});

test('practical score range and quiz validation', async () => {
  assert.equal((await tc.post('/api/practical-scores', { trainee_id: tech.id, skill_id: skills[0], score: 4 })).status, 400);
  assert.equal((await tc.post(`/api/modules/${mod.id}/questions`, { prompt: 'q', options: ['a', 'b'], correct_index: 5 })).status, 400);
});
