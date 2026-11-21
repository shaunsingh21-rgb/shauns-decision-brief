'use strict';
const express = require('express');
const { z, parse } = require('../lib/validate');
const { buildExport, importContent } = require('../lib/portability');

const { listBackups, backupAgeHours } = require('../../scripts/lib/backup');
module.exports = function portabilityRoutes(api, ctx) {
  const { P } = api;
  const { db, config, audit } = ctx;
  const rate = require('../middleware/limits')(config);
  // So the Admin screen can show whether nightly backups are really happening (this folder is readable by the app in the standard setups).
  api.get('/admin/backup-status', P('data.manage'), async (_req, res) => {
    const names = listBackups(config.backupDir), newest = names.at(-1) || null;
    res.json({ count: names.length, newest, age_hours: newest ? Math.round(backupAgeHours(newest) * 10) / 10 : null, healthy: !!newest && backupAgeHours(newest) < 36 });
  });
  api.get('/admin/export', P('data.manage'), rate.sensitive, async (req, res) => {
    const data = buildExport(db, { includeAnswers: req.permissions.has('training.author') });
    db.transaction(() => audit(req, 'export.content', null, null, { equipment: data.equipment.length, modules: data.modules.length }))();
    res.set('Content-Disposition', `attachment; filename="avl-hub-content-${new Date().toISOString().slice(0, 10)}.json"`).json(data);
  });
  // Larger body limit applies to this route only, and only after sign-in and the admin check.
  api.post('/admin/import', P('data.manage'), rate.sensitive, express.json({ limit: '6mb' }), async (req, res) => {
    const b = parse(z.object({ data: z.unknown(), dry_run: z.boolean().default(false) }).strict(), req.body);
    const report = importContent(db, b.data, { actor: req.user, config, dryRun: b.dry_run, can: p => req.permissions.has(p) });
    if (!b.dry_run) db.transaction(() => audit(req, 'import.content', null, null, { added: report.added, skipped: report.skipped }))();
    res.json(report);
  });
};
