'use strict';
const express = require('express');
const { z, parse } = require('../lib/validate');
const { buildExport, importContent } = require('../lib/portability');

const ADMIN = ['admin'];
module.exports = function portabilityRoutes(api, ctx) {
  const { db, config, audit } = ctx;
  const rate = require('../middleware/limits')(config);
  api.get('/admin/export', ADMIN, rate.sensitive, async (req, res) => {
    const data = buildExport(db);
    db.transaction(() => audit(req, 'export.content', null, null, { equipment: data.equipment.length, modules: data.modules.length }))();
    res.set('Content-Disposition', `attachment; filename="avl-hub-content-${new Date().toISOString().slice(0, 10)}.json"`).json(data);
  });
  // Larger body limit applies to this route only, and only after sign-in and the admin check.
  api.post('/admin/import', ADMIN, rate.sensitive, express.json({ limit: '6mb' }), async (req, res) => {
    const b = parse(z.object({ data: z.unknown(), dry_run: z.boolean().default(false) }).strict(), req.body);
    const report = importContent(db, b.data, { actor: req.user, config, dryRun: b.dry_run });
    if (!b.dry_run) db.transaction(() => audit(req, 'import.content', null, null, { added: report.added, skipped: report.skipped }))();
    res.json(report);
  });
};
