'use strict';
// Server-side file storage: size/type limits, signature sniffing, authenticated access. Bytes on disk, metadata in SQLite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { HttpError } = require('../lib/errors');
const { z, id, parse } = require('../lib/validate');

const EDITORS = ['admin', 'trainer', 'technician'];
// Allowed types per purpose; the type is decided from the file's own bytes, never from the browser-supplied header or extension.
const ALLOWED = { photo: ['image/jpeg', 'image/png', 'image/webp'], document: ['application/pdf'], video: ['video/mp4', 'video/webm'] };
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}
const safeName = n => (path.basename(String(n || 'file')).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').trim().slice(0, 120)) || 'file';

module.exports = function fileRoutes(api, ctx) {
  const { db, config, audit } = ctx;
  const tmpDir = path.join(config.uploadDir, '_tmp'), storeDir = path.join(config.uploadDir, 'files');
  fs.mkdirSync(tmpDir, { recursive: true }); fs.mkdirSync(storeDir, { recursive: true });
  const limits = { photo: config.maxPhotoMb, document: config.maxDocMb, video: config.maxVideoMb };
  const upload = multer({
    storage: multer.diskStorage({ destination: tmpDir, filename: (_r, _f, cb) => cb(null, crypto.randomUUID()) }),
    limits: { fileSize: Math.max(...Object.values(limits)) * 1048576, files: 1, fields: 4, parts: 6 },
  }).single('file');
  const receive = (req, res, next) => upload(req, res, e => {
    if (!e) return next();
    if (e.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'TOO_LARGE', 'That file is too large.'));
    next(new HttpError(400, 'BAD_UPLOAD', 'The upload could not be read.'));
  });
  const meta = r => ({ id: r.id, purpose: r.purpose, mime: r.mime, size: r.size, name: r.original_name, equipment_id: r.equipment_id, created_at: r.created_at });

  api.post('/files', EDITORS, receive, async (req, res) => {
    const tmp = req.file && req.file.path;
    const bail = (status, code, msg) => { if (tmp) fs.rmSync(tmp, { force: true }); throw new HttpError(status, code, msg); };
    if (!req.file) bail(400, 'NO_FILE', 'Choose a file to upload.');
    let b;
    try { b = parse(z.object({ purpose: z.enum(['photo', 'document', 'video']), equipment_id: id.optional() }).strict(), req.body); }
    catch (e) { if (tmp) fs.rmSync(tmp, { force: true }); throw e; }
    const fd = fs.openSync(tmp, 'r'), head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    const mime = sniff(head);
    if (!mime || !ALLOWED[b.purpose].includes(mime)) bail(415, 'BAD_TYPE', `That file type isn't allowed for ${b.purpose}s. Allowed: ${ALLOWED[b.purpose].map(m => m.split('/')[1]).join(', ')}.`);
    if (req.file.size > limits[b.purpose] * 1048576) bail(413, 'TOO_LARGE', `${b.purpose[0].toUpperCase() + b.purpose.slice(1)}s can be at most ${limits[b.purpose]} MB.`);
    if (b.equipment_id && !db.prepare('SELECT 1 FROM equipment WHERE id=? AND deleted_at IS NULL').get(b.equipment_id)) bail(400, 'BAD_EQUIPMENT', 'Unknown equipment.');
    const fid = crypto.randomUUID();
    fs.renameSync(tmp, path.join(storeDir, fid));                          // stored under a random id: no user-controlled path or extension
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,?,NULL)').run(fid, b.purpose, mime, req.file.size, safeName(req.file.originalname), b.equipment_id || null, req.user.id, new Date().toISOString());
        audit(req, 'file.upload', 'file', fid, { purpose: b.purpose, mime, size: req.file.size });
      })();
    } catch (e) { fs.rmSync(path.join(storeDir, fid), { force: true }); throw e; }
    res.status(201).json({ file: meta(db.prepare('SELECT * FROM files WHERE id=?').get(fid)) });
  });

  api.get('/files', 'any', async (req, res) => {
    const q = parse(z.object({ equipment_id: id.optional(), purpose: z.enum(['photo', 'document', 'video']).optional() }), req.query);
    const rows = db.prepare('SELECT * FROM files WHERE deleted_at IS NULL AND (? IS NULL OR equipment_id=?) AND (? IS NULL OR purpose=?) ORDER BY created_at DESC LIMIT 200')
      .all(q.equipment_id || null, q.equipment_id || null, q.purpose || null, q.purpose || null);
    res.json({ files: rows.map(meta) });
  });

  // Authenticated download. Served with the stored (sniffed) type, nosniff, and a sandboxing CSP so an uploaded file can never run script.
  api.get('/files/:id', 'any', async (req, res) => {
    const f = db.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').get(parse(id, req.params.id));
    if (!f) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
    const p = path.join(storeDir, f.id);
    if (!fs.existsSync(p)) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
    const inline = f.purpose !== 'document';
    res.set({ 'Content-Type': f.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}` });
    res.sendFile(p, { dotfiles: 'allow', acceptRanges: true, cacheControl: false });   // supports Range, so video seeking works
  });

  api.delete('/files/:id', ['admin', 'trainer'], async (req, res) => {
    const f = db.prepare('SELECT * FROM files WHERE id=? AND deleted_at IS NULL').get(parse(id, req.params.id));
    if (!f) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
    if (db.prepare('SELECT 1 FROM photo_panels WHERE file_id=? AND deleted_at IS NULL UNION SELECT 1 FROM lesson_videos WHERE file_id=?').get(f.id, f.id))
      throw new HttpError(409, 'IN_USE', 'This file is used by a panel or lesson video. Remove that first.');
    db.transaction(() => { db.prepare('UPDATE files SET deleted_at=? WHERE id=?').run(new Date().toISOString(), f.id); audit(req, 'file.delete', 'file', f.id); })();
    fs.rmSync(path.join(storeDir, f.id), { force: true });
    res.json({ ok: true });
  });
};
