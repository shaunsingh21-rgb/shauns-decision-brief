'use strict';
const express = require('express');
const { requireAuth, requireRole } = require('./middleware/security');

// Every route MUST declare access: 'public' | 'any' (any signed-in user) | [roles].
// The registry is exported so tests can prove every mutating endpoint is permission-checked.
module.exports = function makeApi() {
  const router = express.Router();
  const registry = [];
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const api = { router, registry };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    api[method] = (path, access, ...handlers) => {
      const ok = access === 'public' || access === 'any' || (Array.isArray(access) && access.length && access.every(r => ['admin', 'trainer', 'technician', 'viewer'].includes(r)));
      if (!ok) throw new Error(`Route ${method.toUpperCase()} ${path} must declare access ('public' | 'any' | [roles])`);
      registry.push({ method: method.toUpperCase(), path: '/api' + path, access });
      const mw = [];
      if (access !== 'public') mw.push(requireAuth);
      if (Array.isArray(access)) mw.push(requireRole(access));
      router[method](path, ...mw, ...handlers.map(wrap));
    };
  }
  return api;
};
