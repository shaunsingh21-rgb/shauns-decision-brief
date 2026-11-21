import { h, clear, field, select, statusBadge, fmtDate, plural } from '../dom.js';
import { get, post, del, upload, mutate } from '../api.js';
import { mmss, parseTime } from '../media.js';
import { can, toast, errMsg, state, noteQueued } from '../app.js';

const AUTHORS = ['training.author'], LEARN = ['training.take'];
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
        p?.signed_off && (p.signed_off.stale ? h('div', { class: 'badge b-needs_review' }, 'Signed off · material changed since') : h('div', { class: 'badge b-approved' }, 'Signed off'))); })) : h('p', { class: 'hint' }, 'No modules at this level yet.'));
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
  const run = fn => async () => { try { noteQueued(await fn()); await reload(); } catch (x) { toast(errMsg(x)); } };
  const { progress } = await get(`/progress/${state.user.id}`);
  const me = progress.find(p => p.module_id === id);

  root.append(h('p', {}, h('a', { href: '#/training' }, '← Training')), h('h1', {}, m.title), h('div', { class: 'row' }, h('span', { class: 'badge b-draft' }, LEVELS[m.level - 1]), statusBadge(m.status)),
    m.status !== 'approved' && h('div', { class: 'notice' }, m.status === 'needs_review' ? 'This material changed or is waiting for review. It must be approved again.' : 'Draft material — not approved yet.'),
    m.summary && h('p', {}, m.summary));

  // ---- written ----
  const w = h('div', { class: 'card' }, h('h2', {}, 'Written quiz'));
  if (!m.quiz.length) w.append(h('p', { class: 'hint' }, 'No quiz questions yet.'));
  else if (can(...LEARN) && m.status !== 'approved') w.append(h('p', { class: 'hint' }, 'The quiz opens once a leader approves this module.'));
  else if (can(...LEARN)) {
    const picks = {}; const result = h('div', { role: 'status', 'aria-live': 'polite' });
    const bestText = pct => `Pass mark ${me.written.pass_pct}%. Your best: ${pct == null ? 'not taken yet' : pct + '%'}.`;
    const best = h('p', { class: 'hint' }, bestText(me.written.best_pct)); let bestPct = me.written.best_pct;
    w.append(best,
      ...m.quiz.map((q, i) => h('fieldset', {}, h('legend', {}, `${i + 1}. ${q.prompt}`), q.options.map((o, j) => h('label', { class: 'opt plain' },
        h('input', { type: 'radio', name: q.id, onchange: () => picks[q.id] = j }), o)))),
      result, h('button', { class: 'primary', onclick: async () => {
        const blank = m.quiz.length - Object.keys(picks).length;
        if (blank > 0) return clear(result).append(h('div', { class: 'notice bad', role: 'alert' }, `Answer every question first (${blank === 1 ? '1 is' : blank + ' are'} still blank).`));
        try { const r = await mutate('POST', `/modules/${id}/quiz-attempts`, { answers: picks }, { label: `Quiz answers for “${m.title}”` });
          if (r.queued) return clear(result).append(h('div', { class: 'notice' }, 'Your answers are saved on this device. They are graded when you’re back online, and your score will show here then.'));
          bestPct = Math.max(bestPct ?? 0, r.score_pct); best.textContent = bestText(bestPct);
          clear(result).append(h('div', { class: `notice ${r.passed ? 'ok' : 'bad'}` }, `Score ${r.score_pct}%. ${r.passed ? 'Passed.' : `You need ${r.pass_pct}% to pass. Review the material and try again.`}`)); }
        catch (x) { clear(result).append(h('div', { class: 'notice bad', role: 'alert' }, errMsg(x))); } } }, 'Submit answers'));
  } else w.append(h('p', { class: 'hint' }, `${plural(m.quiz.length, 'question')}. Your role can’t take quizzes.`));
  if (can(...AUTHORS)) w.append(h('h3', {}, 'Questions (trainer view)'), h('ul', {}, m.quiz.map(q => h('li', {}, q.prompt, ' — answer: ', q.options[q.correct_index], ' ',
    h('button', { class: 'danger', 'aria-label': `Remove question ${q.prompt}`, onclick: run(() => del(`/questions/${q.id}`)) }, 'Remove')))), questionForm(id, reload));

  // ---- practical ----
  const p = h('div', { class: 'card' }, h('h2', {}, 'Practical skills'), h('p', { class: 'hint' }, 'Scored by a trainer, 0–3. Every skill needs 2 or more.'),
    m.skills.length ? h('ul', {}, me.practical.skills.map(s => h('li', {}, `${s.name}: `, s.score == null ? 'not scored' : RUBRIC[s.score][1],
      can(...AUTHORS) && ' ', can(...AUTHORS) && h('button', { class: 'danger', 'aria-label': `Remove skill ${s.name}`, onclick: run(() => del(`/skills/${s.skill_id}`)) }, 'Remove')))) : h('p', { class: 'hint' }, 'No skills defined yet.'));
  if (can(...AUTHORS)) p.append(skillForm(id, reload));

  // Who signed this person off, when, and whether the material has changed since (the sign-off stays on record either way).
  if (me.signed_off) {
    const { people } = await get('/people').catch(() => ({ people: [] })); const by = (people.find(x => x.id === me.signed_off.by) || {}).display_name || 'a trainer';
    root.append(h('div', { class: `notice ${me.signed_off.stale ? '' : 'ok'}` }, me.signed_off.stale
      ? `You were signed off by ${by} on ${fmtDate(me.signed_off.at)}, but this material has changed since. Ask a trainer to renew your sign-off.`
      : `Signed off by ${by} on ${fmtDate(me.signed_off.at)}.`));
  }
  root.append(w, p, await videosCard(m, id, reload));
  if (can('training.score', 'training.signoff')) root.append(await trainerPanel(m, reload));
  if (can('training.author', 'training.approve')) root.append(h('div', { class: 'card' }, h('h2', {}, 'Review'), h('div', { class: 'row' },
    m.status === 'draft' && can('training.author') && h('button', { onclick: run(() => mutate('POST', `/modules/${id}/submit-review`, {}, { label: `Submit “${m.title}” for review` })) }, 'Submit for review'),
    can('training.approve') && m.status !== 'approved' && h('button', { class: 'primary', onclick: run(() => mutate('POST', `/modules/${id}/approve`, { reviewed_version: m.version }, { label: `Approve “${m.title}”` })) }, 'Approve material'))));
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
  const others = people.filter(x => x.id !== state.user.id && x.can_train);
  const sel = select([['', 'Choose a trainee…'], ...others.map(x => [x.id, x.display_name])], ''); sel.setAttribute('aria-label', 'Trainee');
  const body = h('div');
  sel.addEventListener('change', async () => {
    clear(body); if (!sel.value) return;
    const { progress } = await get(`/progress/${sel.value}`); const t = progress.find(x => x.module_id === m.id);
    const scoreSel = {}; const noteBox = h('input', { maxlength: 500 });
    body.append(h('p', {}, `Written: ${t.written.best_pct ?? 'not taken'}${t.written.best_pct != null ? '%' : ''} ${t.written.passed ? '✓' : ''}`),
      ...t.practical.skills.map(s => { const sc = select(RUBRIC, s.score ?? 0); scoreSel[s.skill_id] = sc; sc.setAttribute('aria-label', `Score for ${s.name}`);
        if (!can('training.score')) return h('div', { class: 'row' }, h('span', { class: 'grow' }, `${s.name} (now: ${s.score ?? 'unscored'})`));
        return h('div', { class: 'row' }, h('span', { class: 'grow' }, `${s.name} (now: ${s.score ?? 'unscored'})`), sc,
          h('button', { onclick: async () => { try { const r = await mutate('POST', '/practical-scores', { trainee_id: sel.value, skill_id: s.skill_id, score: +sc.value }, { label: `Score “${s.name}”` }); if (!noteQueued(r)) toast(r.signed_off_warning ? 'Score saved. This person is already signed off; the sign-off stays on record, so check it still stands.' : 'Score saved.'); sel.dispatchEvent(new Event('change')); } catch (x) { toast(errMsg(x)); } } }, 'Save score')); }),
      t.signed_off && !t.signed_off.stale ? h('div', { class: 'notice ok' }, `Signed off on ${fmtDate(t.signed_off.at)}.`) : !can('training.signoff') ? null : m.status !== 'approved' ? h('div', { class: 'notice' }, 'This module must be approved before anyone can be signed off on it.') : h('div', {}, t.signed_off && t.signed_off.stale && h('div', { class: 'notice' }, 'This person was signed off on an earlier version. The material has changed since, so the sign-off can be renewed once they meet the current requirements.'), field('Note for the record (optional)', noteBox), h('button', { class: 'primary', onclick: async () => {
        try { const r = await mutate('POST', '/signoffs', { trainee_id: sel.value, module_id: m.id, ...(noteBox.value.trim() ? { note: noteBox.value.trim() } : {}) }, { label: `Sign off on “${m.title}”` }); if (!noteQueued(r)) toast('Signed off.'); await reload(); }
        catch (x) { body.append(h('div', { class: 'notice bad', role: 'alert' }, errMsg(x), x.data?.missing ? h('ul', {}, x.data.missing.map(t2 => h('li', {}, t2))) : null)); } } }, t.signed_off && t.signed_off.stale ? 'Renew the sign-off' : 'Sign off this trainee')));
  });
  return h('div', { class: 'card' }, h('h2', {}, 'Trainer: score and sign off'), h('p', { class: 'hint' }, 'You can’t score or sign off yourself.'), field('Trainee', sel), body);
}

async function videosCard(m, id, reload) {
  const { videos } = await get(`/modules/${id}/videos`);
  const card = h('div', { class: 'card' }, h('h2', {}, 'Lesson videos'),
    h('p', { class: 'hint' }, 'Lesson videos live in SharePoint. Checkpoints on SharePoint and link videos can’t pause the video for you, so answer them as you reach each time. Uploaded videos pause automatically.'));
  if (!videos.length) card.append(h('p', { class: 'hint' }, 'No lesson videos yet.'));
  for (const v of videos) card.append(videoBlock(v, reload));
  if (can(...AUTHORS)) card.append(videoForm(id, reload));
  return card;
}

function checkpointUi(c, { onAnswered } = {}) {
  let choice = null; const out = h('div', { role: 'status', 'aria-live': 'polite' });
  const prior = c.answered ? h('span', { class: `badge ${c.answered.correct ? 'b-approved' : 'b-needs_review'}` }, c.answered.correct ? 'Answered correctly' : 'Answered — review it') : null;
  const box = h('fieldset', { class: 'checkpoint' }, h('legend', {}, `Checkpoint at ${mmss(c.at_seconds)}: ${c.prompt}`), prior,
    c.options.map((o, j) => h('label', { class: 'opt plain' }, h('input', { type: 'radio', name: `cp${c.id}`, onchange: () => choice = j }), o)),
    !can('training.take') ? h('p', { class: 'hint' }, 'Your role can’t answer checkpoints.') : h('button', { onclick: async () => {
      if (choice == null) return toast('Choose an answer.');
      try { const r = await mutate('POST', `/checkpoints/${c.id}/answer`, { choice }, { label: 'Video checkpoint answer' }); if (r.queued) return out.replaceChildren(h('div', { class: 'notice' }, 'Answer saved on this device. Feedback appears once you’re back online.')); out.replaceChildren(h('div', { class: `notice ${r.correct ? 'ok' : 'bad'}` }, r.correct ? 'Correct.' : `Not quite. The answer is: ${c.options[r.correct_index]}.`)); onAnswered?.(r); }
      catch (x) { toast(errMsg(x)); } } }, 'Check answer'), out);
  return box;
}

function videoBlock(v, reload) {
  const wrap = h('div', { class: 'video-block' }, h('h3', {}, v.title, ' ', h('span', { class: 'badge b-draft' }, { sharepoint_embed: 'SharePoint', upload: 'Uploaded file', link: 'Link' }[v.kind])));
  let player;
  if (v.kind === 'sharepoint_embed') player = h('iframe', { class: 'video-frame', src: v.url, title: v.title, allow: 'fullscreen', allowfullscreen: true, referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups', loading: 'lazy' });
  else if (v.kind === 'upload') player = h('video', { class: 'lesson', controls: true, playsinline: true, preload: 'metadata', src: `/api/files/${v.file_id}`, 'aria-label': v.title });
  else player = h('p', {}, h('a', { class: 'btn', href: v.url }, `Open video (${new URL(v.url).hostname})`));
  wrap.append(player);

  const pending = new Set(), shown = new Set(); const holder = h('div');
  const cps = v.checkpoints.map(c => ({ c, ui: checkpointUi(c, { onAnswered: () => { pending.delete(c.id); if (player.play && !player.ended) cont.hidden = false; } }) }));
  const cont = h('button', { class: 'primary', hidden: true, onclick: () => { cont.hidden = true; player.play(); } }, 'Continue the video');
  if (v.kind === 'upload' && cps.length) {
    player.addEventListener('timeupdate', () => {
      const due = cps.find(({ c }) => !shown.has(c.id) && player.currentTime >= c.at_seconds && player.currentTime < c.at_seconds + 3);
      if (!due) return; shown.add(due.c.id); pending.add(due.c.id); player.pause();
      clear(holder).append(due.ui); due.ui.querySelector('input')?.focus(); due.ui.scrollIntoView({ block: 'nearest' });
    });
    wrap.append(h('p', { class: 'hint' }, `${cps.length} checkpoint(s): the video pauses at ${cps.map(x => mmss(x.c.at_seconds)).join(', ')}.`), holder, cont);
  } else if (cps.length) wrap.append(h('h4', {}, 'Checkpoints (answer as you watch)'), ...cps.map(x => x.ui));
  if (can(...AUTHORS)) wrap.append(h('div', { class: 'row' }, h('button', { class: 'danger', onclick: async () => { if (confirm('Remove this video?')) { try { await del(`/videos/${v.id}`); await reload(); } catch (x) { toast(errMsg(x)); } } } }, 'Remove video'),
    cpForm(v, reload)), ...v.checkpoints.map(c => h('div', { class: 'hint' }, `${mmss(c.at_seconds)} — ${c.prompt} (answer: ${c.options[c.correct_index]}) `, h('button', { class: 'danger', 'aria-label': `Remove checkpoint at ${mmss(c.at_seconds)}`, onclick: async () => { try { await del(`/checkpoints/${c.id}`); await reload(); } catch (x) { toast(errMsg(x)); } } }, 'Remove'))));
  return wrap;
}

function cpForm(v, reload) {
  const t = h('input', { placeholder: 'm:ss, e.g. 2:30', maxlength: 8 }), q = h('input', { maxlength: 300 }), o = h('textarea', { rows: 3, placeholder: 'One answer per line (2–6)' }), c = h('input', { type: 'number', min: 1, value: 1 });
  return h('details', {}, h('summary', {}, 'Add a checkpoint'), field('Time in the video', t), field('Question', q), field('Answers', o), field('Number of the correct answer', c),
    h('button', { onclick: async () => { const s = parseTime(t.value); if (s == null) return toast('Enter the time as m:ss, e.g. 2:30.');
      try { await post(`/videos/${v.id}/checkpoints`, { at_seconds: s, prompt: q.value, options: o.value.split('\n').map(x => x.trim()).filter(Boolean), correct_index: +c.value - 1 }); await reload(); } catch (x) { toast(errMsg(x)); } } }, 'Add checkpoint'));
}

function videoForm(id, reload) {
  const kind = select([['sharepoint_embed', 'SharePoint (recommended)'], ['link', 'Link only'], ['upload', 'Upload a file (small clips only)']], 'sharepoint_embed');
  const title = h('input', { maxlength: 160 }), url = h('input', { placeholder: 'https://…sharepoint.com/…', maxlength: 2048 }), file = h('input', { type: 'file', accept: 'video/mp4,video/webm', 'aria-label': 'Choose a video file' });
  const urlBox = field('Link', url, 'For SharePoint, use the video’s Embed link (Share → Embed).'), fileBox = field('Video file (MP4 or WebM)', file, 'Prefer SharePoint: files uploaded here are stored on this server.');
  const sync = () => { urlBox.hidden = kind.value === 'upload'; fileBox.hidden = kind.value !== 'upload'; }; kind.addEventListener('change', sync); sync();
  return h('details', {}, h('summary', {}, 'Add a lesson video'), field('Where is the video?', kind), field('Title', title), urlBox, fileBox, h('button', { class: 'primary', onclick: async () => {
    try {
      const body = { title: title.value, kind: kind.value };
      if (kind.value === 'upload') { const f = file.files[0]; if (!f) return toast('Choose a video file.'); body.file_id = (await upload(f, { purpose: 'video' })).id; } else body.url = url.value;
      await post(`/modules/${id}/videos`, body); toast('Video added.'); await reload();
    } catch (x) { toast(errMsg(x)); } } }, 'Add video'));
}
