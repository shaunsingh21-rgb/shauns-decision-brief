'use strict';
// "About this server": what an administrator reads out when they phone the developer. Admin screen: add a small "About" box that calls this.
const support = require('../lib/support');
module.exports = function supportRoutes(api, ctx) {
  const { P } = api;
  const started = Date.now();
  api.get('/admin/about', P('data.manage'), async (_req, res) => {
    const h = ctx.health();
    res.json({ app: support.buildInfo(), schema: support.schemaInfo(ctx.db), uptime_seconds: Math.round((Date.now() - started) / 1000),
      mode: ctx.config.production ? 'production' : 'NOT production', health: { status: h.status, problems: h.problems, warnings: h.warnings, checks: h.checks },
      features: { two_step: !!ctx.config.mfaEncryptionKey, web_search: !!ctx.config.braveApiKey, ai: !!ctx.config.anthropicApiKey, sharepoint_hosts: ctx.config.sharepointHosts },
      log_file: ctx.log.file() ? 'avl.log (rotating, 5 x 2 MB) in the data folder' : null });
  });
};
