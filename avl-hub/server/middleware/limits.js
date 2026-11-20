'use strict';
const rateLimit = require('express-rate-limit');
// Per-USER limits (routes using these are always behind sign-in), on top of the per-IP API limit and the login lockout.
module.exports = config => {
  const mk = (limit, windowMs, what) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: req => req.user.id,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Too many ${what}. Please wait a while and try again.` } }) });
  return {
    upload: mk(config.rateUploadsPerHour, 3600e3, 'uploads'),
    sensitive: mk(config.rateSensitivePerHour, 3600e3, 'account or data-management actions'),
    password: mk(config.ratePasswordPer15Min, 900e3, 'password attempts'),
  };
};
