'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const loadConfig = require('./config');
const { open, migrate } = require('./db');
const makeAudit = require('./audit');
const createAuth = require('./auth');
const makeApi = require('./api');
const { session, csrf } = require('./middleware/security');
const idempotency = require('./middleware/idempotency');
const { HttpError } = require('./lib/errors');

// The service worker is generated from the real files so its precache list and version can never drift from what is deployed.
function buildServiceWorker(pub) {
  const crypto = require('crypto');
  const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? (rel === '' && e.name === 'vendor' ? [] : walk(path.join(d, e.name), rel + '/' + e.name)) : [rel + '/' + e.name]);
  const assets = walk(pub).filter(f => f !== '/sw.js').sort();
  const hash = crypto.createHash('sha256');
  for (const f of assets) { hash.update(f); hash.update(fs.readFileSync(path.join(pub, f))); }
  const version = hash.digest('hex').slice(0, 12);
  const shell = ['/', ...assets];
  const body = fs.readFileSync(path.join(__dirname, 'sw.template.js'), 'utf8').replaceAll('__VERSION__', version).replaceAll('__ASSETS__', JSON.stringify(shell));
  if (body.includes('__VERSION__') || body.includes('__ASSETS__')) throw new Error('service worker template was not fully filled in');
  return { body, version, assets: shell };
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = open(config.dbPath);
  migrate(db);
  const ctx = { config, db, audit: makeAudit(db), fetch: overrides.fetchImpl || globalThis.fetch };
  ctx.auth = createAuth(ctx);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'wasm-unsafe-eval'"], workerSrc: ["'self'", 'blob:'], styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"],
      frameSrc: config.sharepointHosts.length ? config.sharepointHosts.map(x => 'https://' + x) : ['https://*.sharepoint.com'], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      ...(config.production ? { upgradeInsecureRequests: [] } : { upgradeInsecureRequests: null }),
    } },
    hsts: config.production,
  }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const api = makeApi();
  app.use('/api', rateLimit({ windowMs: 60000, limit: config.apiRateMax, standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } }) }));
  app.use('/api', express.json({ limit: '256kb' }), (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    session(ctx), csrf, idempotency(ctx), api.router);
  for (const r of ['auth', 'users', 'equipment', 'training', 'issues', 'install', 'external', 'files', 'lessons', 'panels']) require(`./routes/${r}`)(api, ctx);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'No such endpoint.')));

  const pub = path.join(__dirname, '..', 'public');
  if (fs.existsSync(pub)) {
    const sw = buildServiceWorker(pub);
    app.get('/sw.js', (_req, res) => res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).send(sw.body));
    app.get('/precache.json', (_req, res) => res.set('Cache-Control', 'no-cache').json({ version: sw.version, assets: sw.assets }));
    app.use(express.static(pub, { setHeaders: (res, p) => {
      res.set('Cache-Control', 'no-cache');                                           // always revalidate; the service worker handles offline
      if (p.endsWith('.webmanifest')) res.type('application/manifest+json');
    } }));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON.' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request too large.' } });
    console.error(err);                                                  // details stay in the server log
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  ctx.auth.sessions.purgeExpired();
  return { app, ctx, registry: api.registry, close: () => db.close() };
}

if (require.main === module) {
  const { app, ctx } = createApp();
  app.listen(ctx.config.port, () => console.log(`AVL Hub listening on :${ctx.config.port}`));
}
module.exports = { createApp };
