'use strict';
process.umask(0o077);   // the database, its WAL files and uploads are private to the service account
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
const support = require('./lib/support');
const crypto = require('crypto');

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
  const log = support.makeLogger(config.logDir || path.join(path.dirname(config.dbPath), 'logs'), { quiet: !!process.env.NODE_TEST_CONTEXT && require.main !== module });   // test servers started in-process stay quiet
  const ctx = { config, db, log, audit: makeAudit(db), fetch: overrides.fetchImpl || globalThis.fetch, clock: overrides.clock || Date.now };
  ctx.roles = makeRoles(db);
  ctx.mfa = makeMfa(ctx);
  ctx.auth = createAuth(ctx);

  const app = express();
  app.disable('x-powered-by');
  // Request log: one line per API call (and per error), with an id that is also sent back as X-Request-Id and shown in the error body,
  // so "it said Something went wrong, reference 3fa9c1d2" can be found in the log. No query strings, bodies, cookies or passwords are logged.
  app.use((req, res, next) => {
    req.id = crypto.randomBytes(4).toString('hex'); res.set('X-Request-Id', req.id); const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/healthz' || !(req.path.startsWith('/api') || res.statusCode >= 400)) return;
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      (res.statusCode >= 500 ? log.error : log.info)(`req=${req.id} ${req.method} ${req.path} ${res.statusCode} ${ms}ms user=${(req.user && req.user.id) || '-'}`);
    });
    next();
  });
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
  // Deep health check: answers 503 only for things that make the app unusable (database unreadable or replaced, schema mismatch, uploads unwritable, disk full).
  // Warnings (old backup, low disk) are reported but stay 200, so Docker does not restart a working server.
  const health = support.makeHealth(ctx); ctx.health = health;
  app.get('/healthz', (_req, res) => { const h = health(); res.status(h.ok ? 200 : 503).json({ ok: h.ok, status: h.status, problems: h.problems, warnings: h.warnings }); });

  const api = makeApi({ idem: idempotency(ctx) });                        // replay protection runs AFTER the permission check, per route
  // The request limit is per PERSON once signed in (a whole team behind one office address no longer shares a single budget), per address before that.
  const apiLimit = rateLimit({ windowMs: 60000, limit: req => (req.method === 'GET' ? config.apiReadRateMax : config.apiRateMax), standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => (req.user ? 'u:' + req.user.id : ipKeyGenerator(req.ip)),
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } }) });
  const smallJson = express.json({ limit: '256kb' });
  app.use('/api', (req, res, next) => (req.path === '/admin/import' ? next() : smallJson(req, res, next)),   // import has its own larger limit, after sign-in
    (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, session(ctx), apiLimit, csrf, api.router);
  for (const r of ['auth', 'users', 'equipment', 'training', 'issues', 'install', 'external', 'files', 'lessons', 'panels', 'portability', 'roles', 'mfa', 'support']) require(`./routes/${r}`)(api, ctx);
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
    const why = support.explainError(err);
    log.error(`req=${_req.id} ${_req.method} ${_req.path} FAILED: ${why.short}${why.fix ? ' | WHAT TO DO: ' + why.fix : ''}`, err);   // details stay in the server log
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.', request_id: _req.id } });
  server.requestTimeout = 0;   // PROTOTYPE: Node's default (300 s) kills a 150 MB upload from a phone slower than ~4 Mbit/s. headersTimeout (60 s) still protects against slow-loris.
  });

  // Housekeeping: expired sessions, old replay records, stale lockout counters.
  ctx.maintain = () => {
    const now = Date.now(), iso = ms => new Date(now - ms).toISOString();
    ctx.auth.sessions.purgeExpired();
    db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(iso(30 * 864e5));
    db.prepare('DELETE FROM login_failures WHERE (locked_until IS NULL OR locked_until < ?) AND updated_at < ?').run(new Date(now).toISOString(), iso(864e5));
  };
  ctx.maintain();
  const timer = setInterval(() => { try { ctx.maintain(); } catch (e) { log.error('maintenance failed', e.message); } }, 6 * 3600e3); timer.unref();
  if (config.nodeEnvRaw && !['production', 'development', 'test'].includes(config.nodeEnvRaw)) log.warn(`NODE_ENV is "${config.nodeEnvRaw}", which is NOT "production": the app is running with insecure cookies and no HSTS. Fix it in .env (exactly: production).`);
  if (config.production && !config.trustProxy) log.warn('NODE_ENV=production but TRUST_PROXY is not set. Behind a reverse proxy (Caddy, nginx) set TRUST_PROXY=1 so rate limits see real client addresses.');
  return { app, ctx, registry: api.registry, close: () => { clearInterval(timer); db.close(); } };
}

if (require.main === module) {
  // Anything that stops the app from starting is reported as ONE plain sentence plus what to do, never a raw stack trace (the stack goes to the log file).
  const fatal = (e, where) => {
    const why = support.explainError(e), lg = support.makeLogger(process.env.LOG_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'x')), 'logs'));
    lg.fatal(`AVL Hub could not start (${where}): ${why.short.replace(/\.$/, '')}.${why.fix ? ' WHAT TO DO: ' + why.fix : ''}`); lg.detail(e); process.exit(1);
  };
  const cfg0 = loadConfig();
  if (!Number.isInteger(cfg0.port) || cfg0.port < 1 || cfg0.port > 65535) fatal(new Error(`PORT in .env is "${process.env.PORT}", which is not a port number (use for example 3000)`), 'settings');
  let started; try { started = createApp(); } catch (e) { fatal(e, /MFA_ENCRYPTION_KEY/.test(e.message) ? 'settings' : e.code === 'SCHEMA_TOO_NEW' ? 'database version' : 'database'); }
  const { app, ctx, close } = started;
  const { log } = ctx, b = support.buildInfo(), sch = support.schemaInfo(ctx.db);
  const server = app.listen(ctx.config.port, err => {
    // Express 5 hands listen errors to this callback: the old code printed "listening" even when the port was taken, then exited with code 0.
    if (err) { log.fatal(`AVL Hub could not listen on port ${ctx.config.port}: ${support.explainError(err).short}. ${support.explainError(err).fix || ''}`); log.detail(err); try { close(); } catch { /* ignore */ } try { fs.rmSync(beat, { force: true }); } catch { /* ignore */ } process.exit(1); }
    log.info(`AVL Hub ${b.version} (commit ${b.commit}) listening on :${ctx.config.port} | mode=${ctx.config.production ? 'production' : 'NOT-production'} | node ${b.node} | database schema ${sch.latest_applied} (${sch.applied}/${sch.known})`);
    log.info(`data: db=${ctx.config.dbPath} uploads=${ctx.config.uploadDir} backups=${ctx.config.backupDir} log=${log.file() || '(console only)'}`);
    log.info(`features: two-step=${ctx.config.mfaEncryptionKey ? 'on' : 'off'} sharepoint=${ctx.config.sharepointHosts.join(',') || 'any *.sharepoint.com'} web-search=${ctx.config.braveApiKey ? 'on' : 'off'} ai=${ctx.config.anthropicApiKey ? 'on' : 'off'} trust-proxy=${ctx.config.trustProxy}`);
    const h = ctx.health(); for (const p of h.problems) log.error('HEALTH PROBLEM: ' + p); for (const w of h.warnings) log.warn('HEALTH WARNING: ' + w);
  });
  server.on('error', e => { if (e.code !== 'EADDRINUSE' || server.listening) log.error('server error', e); });
  // A heartbeat file next to the database tells restore (which may run in another container) that the app is live and must be stopped first.
  const beat = path.join(path.dirname(ctx.config.dbPath), '.avl-running');
  const touch = () => { try { fs.writeFileSync(beat, String(Date.now())); } catch { /* read-only data folder: nothing to signal */ } };
  touch(); const hb = setInterval(touch, 5000); hb.unref();
  // Stop cleanly on SIGTERM/SIGINT (docker stop, systemctl stop, Ctrl+C): finish requests, close the database, remove the signal.
  let stopping = false;
  const stop = sig => {
    if (stopping) return; stopping = true; log.info(`${sig} received: finishing requests, then shutting down.`); clearInterval(hb);
    setTimeout(() => process.exit(1), 10000).unref();
    server.close(() => { try { close(); } catch { /* already closed */ } try { fs.rmSync(beat, { force: true }); } catch { /* ignore */ } process.exit(0); });
    if (server.closeIdleConnections) server.closeIdleConnections();
  };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  process.on('uncaughtException', e => { log.fatal('Unexpected crash: ' + support.explainError(e).short, e); process.exit(1); });
  process.on('unhandledRejection', e => { log.error('Unhandled error', e); });
}
module.exports = { createApp };
