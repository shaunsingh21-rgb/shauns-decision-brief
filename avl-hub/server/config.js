'use strict';
// All configuration comes from environment variables. No secrets live in code.
const path = require('path');
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
module.exports = function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    port: int(env.PORT, 3000),
    dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'avl-hub.db'),
    uploadDir: env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    production: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY ? int(env.TRUST_PROXY, 1) : 0,   // set 1 behind Caddy/nginx
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    cookieName: env.NODE_ENV === 'production' ? '__Host-avl_sid' : 'avl_sid',
    lockoutMaxFailures: int(env.LOCKOUT_MAX_FAILURES, 5),
    lockoutMinutes: int(env.LOCKOUT_MINUTES, 15),
    loginIpMax: int(env.LOGIN_IP_MAX, 30),                       // per 15 min per IP
    apiRateMax: int(env.API_RATE_MAX, 600),                      // per minute per IP
    minPasswordLength: int(env.MIN_PASSWORD_LENGTH, 12),
    authProvider: env.AUTH_PROVIDER || 'local',
    // Used only by server-side features in later phases; never sent to the client.
    braveApiKey: env.BRAVE_API_KEY || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    ...overrides,
  };
};
