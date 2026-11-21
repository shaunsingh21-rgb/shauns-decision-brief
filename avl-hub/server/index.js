'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const loadConfig = require('./config');
const { open, migrate } = require('./db');
const makeAudit = require('./audit');
const makeRoles = require('./lib/roles');
const makeMfa = require('./lib/mfa');
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
  const ctx = { config, db, audit: makeAudit(db), fetch: overrides.fetchImpl || globalThis.fetch, clock: overrides.clock || Date.now };
  ctx.roles = makeRoles(db);
  ctx.mfa = makeMfa(ctx);
  ctx.auth = createAuth(ctx);

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()'); next(); });
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

  const api = makeApi({ idem: idempotency(ctx) });                        // replay protection runs AFTER the permission check, per route
  // The request limit is per PERSON once signed in (a whole team behind one office address no longer shares a single budget), per address before that.
  const apiLimit = rateLimit({ windowMs: 60000, limit: config.apiRateMax, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => (req.user ? 'u:' + req.user.id : ipKeyGenerator(req.ip)),
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } }) });
  const smallJson = express.json({ limit: '256kb' });
  app.use('/api', (req, res, next) => (req.path === '/admin/import' ? next() : smallJson(req, res, next)),   // import has its own larger limit, after sign-in
    (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, session(ctx), apiLimit, csrf, api.router);
  for (const r of ['auth', 'users', 'equipment', 'training', 'issues', 'install', 'external', 'files', 'lessons', 'panels', 'portability', 'roles', 'mfa']) require(`./routes/${r}`)(api, ctx);
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
    // Malformed input (a bad URL escape, a broken encoded body…) is the caller's mistake: a 400, not a server error with a stack trace.
    if (err instanceof URIError || (err.status >= 400 && err.status < 500)) return res.status(err.status || 400).json({ error: { code: 'BAD_REQUEST', message: 'That request could not be understood.' } });
    console.error(err);                                                  // details stay in the server log
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  // Housekeeping: expired sessions, old replay records, stale lockout counters.
  ctx.maintain = () => {
    const now = Date.now(), iso = ms => new Date(now - ms).toISOString();
    ctx.auth.sessions.purgeExpired();
    db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(iso(30 * 864e5));
    db.prepare('DELETE FROM login_failures WHERE (locked_until IS NULL OR locked_until < ?) AND updated_at < ?').run(new Date(now).toISOString(), iso(864e5));
  };
  ctx.maintain();
  const timer = setInterval(() => { try { ctx.maintain(); } catch (e) { console.error('maintenance failed', e.message); } }, 6 * 3600e3); timer.unref();
  if (config.production && !config.trustProxy) console.warn('WARNING: NODE_ENV=production but TRUST_PROXY is not set. Behind a reverse proxy (Caddy, nginx) set TRUST_PROXY=1 so rate limits see real client addresses.');
  return { app, ctx, registry: api.registry, close: () => { clearInterval(timer); db.close(); } };
}

if (require.main === module) {
  const { app, ctx, close } = createApp();
  const server = app.listen(ctx.config.port, () => console.log(`AVL Hub listening on :${ctx.config.port}`));
  // A heartbeat file next to the database tells restore (which may run in another container) that the app is live and must be stopped first.
  const beat = path.join(path.dirname(ctx.config.dbPath), '.avl-running');
  const touch = () => { try { fs.writeFileSync(beat, String(Date.now())); } catch { /* read-only data folder: nothing to signal */ } };
  touch(); const hb = setInterval(touch, 5000); hb.unref();
  // Stop cleanly on SIGTERM/SIGINT (docker stop, systemctl stop, Ctrl+C): finish requests, close the database, remove the signal.
  let stopping = false;
  const stop = sig => {
    if (stopping) return; stopping = true; console.log(`${sig} received: finishing requests, then shutting down.`); clearInterval(hb);
    setTimeout(() => process.exit(1), 10000).unref();
    server.close(() => { try { close(); } catch { /* already closed */ } try { fs.rmSync(beat, { force: true }); } catch { /* ignore */ } process.exit(0); });
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
module.exports = { createApp };
