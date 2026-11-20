import { h, clear, field, select, statusBadge } from '../dom.js';
import { get, post, patch, del } from '../api.js';
import { can, toast, errMsg, state } from '../app.js';

const AUTHORS = ['admin', 'trainer'], LEARN = ['admin', 'trainer', 'technician'];
const RUBRIC = [[0, '0 — Not demonstrated'], [1, '1 — Needs coaching'], [2, '2 — Competent, minimal help'], [3, '3 — Independent']];
const LEVELS = ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'];

export async function render(root, { arg }) { return arg ? moduleView(root, arg) : overview(root); }

async function overview(root) {
  const [{ modules }, { progress }] = await Promise.all([get('/modules'), get(`/progress/${state.user.id}`)]);
  const mine = Object.fromEntries(progress.map(p => [p.module_id, p]));
  const title = h('div', { class: 'row between' }, h('h1', {}, 'Training'), can(...AUTHORS) && h('button', { class: 'primary', onclick: () => newModule(root) }, 'New module'));
  root.append(title, h('p', { class: 'hint' }, 'Written (quiz, 80% to pass) and practical (rubric 0–3, every skill 2 or more) are tracked separately. A trainer signs you off when both are met.'));
  for (let l = 1; l <= 5; l++) {
    const ms = modules.filter(m => m.level === l);
    root.append(h('h2', {}, LEVELS[l - 1]), ms.length ? h('div', { class: 'grid' }, ms.map(m => { const p = mine[m.id];
      return h('a', { class: 'card link', href: `#/training/${m.id}` }, h('strong', {}, m.title), h('div', { class: 'row' }, statusBadge(m.status)),
        h('div', { class: 'hint' }, `Written: ${p?.written.best_pct != null ? p.written.best_pct + '%' + (p.written.passed ? ' ✓ passed' : ' — not yet') : 'not taken'}`),
        h('div', { class: 'hint' }, `Practical: ${p?.practical.has_skills ? (p.practical.passed ? '✓ passed' : 'in progress') : 'no skills yet'}`),
        p?.signed_off && h('div', { class: 'badge b-approved' }, 'Signed off')); })) : h('p', { class: 'hint' }, 'No modules at this level yet.'));
  }
}

function newModule(root) {
  const t = h('input', { maxlength: 120 }), l = select(LEVELS.map((x, i) => [i + 1, x]), 1), s = h('textarea', { maxlength: 2000 });
  clear(root).append(h('h1', {}, 'New module'), field('Title', t), field('Level', l), field('Summary', s), h('div', { class: 'row' },
    h('button', { class: 'primary', onclick: async () => { try { const { module } = await post('/modules', { title: t.value, level: +l.value, summary: s.value }); location.hash = `#/training/${module.id}`; } catch (x) { toast(errMsg(x)); } } }, 'Create'),
    h('a', { class: 'btn', href: '#/training' }, 'Cancel')));
}

async function moduleView(root, id) {
  const { module: m } = await get(`/modules/${id}`);
  const reload = () => { clear(root); return moduleView(root, id); };
  const run = fn => async () => { try { await fn(); await reload(); } catch (x) { toast(errMsg(x)); } };
  const { progress } = await get(`/progress/${state.user.id}`);
  const me = progress.find(p => p.module_id === id);

  root.append(h('p', {}, h('a', { href: '#/training' }, '← Training')), h('h1', {}, m.title), h('div', { class: 'row' }, h('span', { class: 'badge b-draft' }, LEVELS[m.level - 1]), statusBadge(m.status)),
    m.status !== 'approved' && h('div', { class: 'notice' }, m.status === 'needs_review' ? 'This material changed or is waiting for review. It must be approved again.' : 'Draft material — not approved yet.'),
    m.summary && h('p', {}, m.summary));

  // ---- written ----
  const w = h('div', { class: 'card' }, h('h2', {}, 'Written quiz'));
  if (!m.quiz.length) w.append(h('p', { class: 'hint' }, 'No quiz questions yet.'));
  else if (can(...LEARN)) {
    const picks = {}; const result = h('div', { role: 'status' });
    w.append(h('p', { class: 'hint' }, `Pass mark ${me.written.pass_pct}%. Your best: ${me.written.best_pct ?? 'not taken'}${me.written.best_pct != null ? '%' : ''}.`),
      ...m.quiz.map((q, i) => h('fieldset', {}, h('legend', {}, `${i + 1}. ${q.prompt}`), q.options.map((o, j) => h('label', { class: 'opt plain' },
        h('input', { type: 'radio', name: q.id, onchange: () => picks[q.id] = j }), o)))),
      h('button', { class: 'primary', onclick: async () => {
        try { const r = await post(`/modules/${id}/quiz-attempts`, { answers: picks });
          clear(result).append(h('div', { class: `notice ${r.passed ? 'ok' : 'bad'}` }, `${r.correct} of ${r.total} correct — ${r.score_pct}%. ${r.passed ? 'Passed.' : `You need ${r.pass_pct}% to pass. You can try again.`}`)); }
        catch (x) { toast(errMsg(x)); } } }, 'Submit answers'), result);
  } else w.append(h('p', { class: 'hint' }, `${m.quiz.length} question(s). Viewers can’t take quizzes.`));
  if (can(...AUTHORS)) w.append(h('h3', {}, 'Questions (trainer view)'), h('ul', {}, m.quiz.map(q => h('li', {}, q.prompt, ' — answer: ', q.options[q.correct_index], ' ',
    h('button', { class: 'danger', 'aria-label': `Remove question ${q.prompt}`, onclick: run(() => del(`/questions/${q.id}`)) }, 'Remove')))), questionForm(id, reload));

  // ---- practical ----
  const p = h('div', { class: 'card' }, h('h2', {}, 'Practical skills'), h('p', { class: 'hint' }, 'Scored by a trainer, 0–3. Every skill needs 2 or more.'),
    m.skills.length ? h('ul', {}, me.practical.skills.map(s => h('li', {}, `${s.name}: `, s.score == null ? 'not scored' : RUBRIC[s.score][1],
      can(...AUTHORS) && ' ', can(...AUTHORS) && h('button', { class: 'danger', 'aria-label': `Remove skill ${s.name}`, onclick: run(() => del(`/skills/${s.skill_id}`)) }, 'Remove')))) : h('p', { class: 'hint' }, 'No skills defined yet.'));
  if (can(...AUTHORS)) p.append(skillForm(id, reload));

  root.append(w, p);
  if (can(...AUTHORS)) root.append(await trainerPanel(m, reload));
  if (can(...AUTHORS)) root.append(h('div', { class: 'card' }, h('h2', {}, 'Review'), h('div', { class: 'row' },
    m.status === 'draft' && h('button', { onclick: run(() => post(`/modules/${id}/submit-review`)) }, 'Submit for review'),
    can('admin') && m.status !== 'approved' && h('button', { class: 'primary', onclick: run(() => post(`/modules/${id}/approve`)) }, 'Approve material'))));
}

function questionForm(id, reload) {
  const q = h('input', { maxlength: 500 }), o = h('textarea', { rows: 4, placeholder: 'One answer per line (2–6)' }), c = h('input', { type: 'number', min: 1, value: 1 });
  return h('details', {}, h('summary', {}, 'Add a question'), field('Question', q), field('Answers', o), field('Number of the correct answer', c),
    h('button', { onclick: async () => { try { await post(`/modules/${id}/questions`, { prompt: q.value, options: o.value.split('\n').map(s => s.trim()).filter(Boolean), correct_index: +c.value - 1 }); await reload(); } catch (x) { toast(errMsg(x)); } } }, 'Add question'));
}
function skillForm(id, reload) {
  const n = h('input', { maxlength: 120 });
  return h('details', {}, h('summary', {}, 'Add a practical skill'), field('Skill', n),
    h('button', { onclick: async () => { try { await post(`/modules/${id}/skills`, { name: n.value }); await reload(); } catch (x) { toast(errMsg(x)); } } }, 'Add skill'));
}

async function trainerPanel(m, reload) {
  const { people } = await get('/people');
  const others = people.filter(x => x.id !== state.user.id && x.role !== 'viewer');
  const sel = select([['', 'Choose a trainee…'], ...others.map(x => [x.id, x.display_name])], ''); sel.setAttribute('aria-label', 'Trainee');
  const body = h('div');
  sel.addEventListener('change', async () => {
    clear(body); if (!sel.value) return;
    const { progress } = await get(`/progress/${sel.value}`); const t = progress.find(x => x.module_id === m.id);
    const scoreSel = {};
    body.append(h('p', {}, `Written: ${t.written.best_pct ?? 'not taken'}${t.written.best_pct != null ? '%' : ''} ${t.written.passed ? '✓' : ''}`),
      ...t.practical.skills.map(s => { const sc = select(RUBRIC, s.score ?? 0); scoreSel[s.skill_id] = sc; sc.setAttribute('aria-label', `Score for ${s.name}`);
        return h('div', { class: 'row' }, h('span', { class: 'grow' }, `${s.name} (now: ${s.score ?? 'unscored'})`), sc,
          h('button', { onclick: async () => { try { await post('/practical-scores', { trainee_id: sel.value, skill_id: s.skill_id, score: +sc.value }); toast('Score saved.'); sel.dispatchEvent(new Event('change')); } catch (x) { toast(errMsg(x)); } } }, 'Save score')); }),
      t.signed_off ? h('div', { class: 'notice ok' }, 'Signed off.') : h('button', { class: 'primary', onclick: async () => {
        try { await post('/signoffs', { trainee_id: sel.value, module_id: m.id }); toast('Signed off.'); await reload(); }
        catch (x) { body.append(h('div', { class: 'notice bad', role: 'alert' }, errMsg(x), x.data?.missing ? h('ul', {}, x.data.missing.map(t2 => h('li', {}, t2))) : null)); } } }, 'Sign off this trainee'));
  });
  return h('div', { class: 'card' }, h('h2', {}, 'Trainer: score and sign off'), h('p', { class: 'hint' }, 'You can’t score or sign off yourself.'), field('Trainee', sel), body);
}
