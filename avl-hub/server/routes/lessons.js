'use strict';
const crypto = require('crypto');
const { HttpError } = require('../lib/errors');
const { z, text, id, parse, httpsUrl, sharepointUrl: spUrl } = require('../lib/validate');

const AUTHORS = ['admin', 'trainer'], LEARNERS = ['admin', 'trainer', 'technician'];

module.exports = function lessonRoutes(api, ctx) {
  const { db, config, audit } = ctx;
  const now = () => new Date().toISOString();
  const mod = mid => { const m = db.prepare('SELECT * FROM training_modules WHERE id=?').get(mid); if (!m) throw new HttpError(404, 'NOT_FOUND', 'Module not found.'); return m; };
  // Editing approved material returns it to Needs Review.
  const touch = (req, mid) => db.prepare(`UPDATE training_modules SET status=CASE WHEN status='approved' THEN 'needs_review' ELSE status END, version=version+1, updated_by=?, updated_at=? WHERE id=?`).run(req.user.id, now(), mid);

  // Only https SharePoint hosts may be embedded (matches the CSP frame-src). Lesson videos stay in SharePoint by default.
  const sharepointUrl = raw => spUrl(raw, config.sharepointHosts);

  api.get('/modules/:id/videos', 'any', async (req, res) => {
    const m = mod(parse(id, req.params.id)); const author = AUTHORS.includes(req.user.role);
    const videos = db.prepare('SELECT id,title,kind,url,file_id,position FROM lesson_videos WHERE module_id=? ORDER BY position,rowid').all(m.id);
    for (const v of videos) {
      v.checkpoints = db.prepare('SELECT id,at_seconds,prompt,options,correct_index FROM video_checkpoints WHERE video_id=? ORDER BY at_seconds,rowid').all(v.id).map(c => ({
        id: c.id, at_seconds: c.at_seconds, prompt: c.prompt, options: JSON.parse(c.options), ...(author ? { correct_index: c.correct_index } : {}),
        answered: (r => r ? { correct: !!r.correct } : null)(db.prepare('SELECT correct FROM checkpoint_responses WHERE user_id=? AND checkpoint_id=? ORDER BY rowid DESC LIMIT 1').get(req.user.id, c.id)) }));
    }
    res.json({ videos });
  });

  api.post('/modules/:id/videos', AUTHORS, async (req, res) => {
    const m = mod(parse(id, req.params.id));
    const b = parse(z.object({ title: text(160, 1), kind: z.enum(['sharepoint_embed', 'upload', 'link']), url: z.string().max(2048).optional(), file_id: id.optional() }).strict(), req.body);
    let url = null, fileId = null;
    if (b.kind === 'upload') {
      const f = b.file_id && db.prepare("SELECT * FROM files WHERE id=? AND purpose='video' AND deleted_at IS NULL").get(b.file_id);
      if (!f) throw new HttpError(400, 'BAD_FILE', 'Choose an uploaded video file.');
      fileId = f.id;
    } else if (b.kind === 'sharepoint_embed') {
      url = b.url && sharepointUrl(b.url);
      if (!url) throw new HttpError(400, 'BAD_SHAREPOINT_URL', config.sharepointHosts.length ? `Embeds must come from: ${config.sharepointHosts.join(', ')}.` : 'Embeds must be https links on your SharePoint (…sharepoint.com).');
    } else {
      url = b.url && httpsUrl(b.url);
      if (!url) throw new HttpError(400, 'BAD_URL', 'Enter a valid https link.');
    }
    const vid = crypto.randomUUID();
    db.transaction(() => {
      const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM lesson_videos WHERE module_id=?').get(m.id).n;
      db.prepare('INSERT INTO lesson_videos VALUES (?,?,?,?,?,?,?,?,?)').run(vid, m.id, b.title, b.kind, url, fileId, pos, req.user.id, now());
      touch(req, m.id); audit(req, 'video.add', 'module', m.id, { video_id: vid, kind: b.kind });
    })();
    res.status(201).json({ id: vid });
  });

  api.delete('/videos/:id', AUTHORS, async (req, res) => {
    const v = db.prepare('SELECT * FROM lesson_videos WHERE id=?').get(parse(id, req.params.id));
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'Video not found.');
    db.transaction(() => { db.prepare('DELETE FROM lesson_videos WHERE id=?').run(v.id); touch(req, v.module_id); audit(req, 'video.remove', 'module', v.module_id, { video_id: v.id }); })();
    res.json({ ok: true });
  });

  api.post('/videos/:id/checkpoints', AUTHORS, async (req, res) => {
    const v = db.prepare('SELECT * FROM lesson_videos WHERE id=?').get(parse(id, req.params.id));
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'Video not found.');
    const b = parse(z.object({ at_seconds: z.number().int().min(0).max(86400), prompt: text(300, 1), options: z.array(text(200, 1)).min(2).max(6), correct_index: z.number().int().min(0) }).strict(), req.body);
    if (b.correct_index >= b.options.length) throw new HttpError(400, 'VALIDATION', 'correct_index out of range.');
    const cid = crypto.randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO video_checkpoints VALUES (?,?,?,?,?,?)').run(cid, v.id, b.at_seconds, b.prompt, JSON.stringify(b.options), b.correct_index);
      touch(req, v.module_id); audit(req, 'checkpoint.add', 'module', v.module_id, { video_id: v.id, at_seconds: b.at_seconds });
    })();
    res.status(201).json({ id: cid });
  });
  api.delete('/checkpoints/:id', AUTHORS, async (req, res) => {
    const c = db.prepare('SELECT c.*, v.module_id FROM video_checkpoints c JOIN lesson_videos v ON v.id=c.video_id WHERE c.id=?').get(parse(id, req.params.id));
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Checkpoint not found.');
    db.transaction(() => { db.prepare('DELETE FROM video_checkpoints WHERE id=?').run(c.id); touch(req, c.module_id); audit(req, 'checkpoint.remove', 'module', c.module_id, { checkpoint_id: c.id }); })();
    res.json({ ok: true });
  });

  // Formative: graded on the server and recorded for the signed-in user; it does not change sign-off rules.
  api.post('/checkpoints/:id/answer', LEARNERS, async (req, res) => {
    const c = db.prepare('SELECT * FROM video_checkpoints WHERE id=?').get(parse(id, req.params.id));
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Checkpoint not found.');
    const b = parse(z.object({ choice: z.number().int().min(0).max(5) }).strict(), req.body);
    const correct = b.choice === c.correct_index;
    db.transaction(() => db.prepare('INSERT INTO checkpoint_responses VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(), req.user.id, c.id, b.choice, +correct, now()))();
    res.status(201).json({ correct, correct_index: c.correct_index });
  });
};
