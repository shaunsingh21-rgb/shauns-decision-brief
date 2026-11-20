'use strict';
const express = require('express');
const { requireAuth, requirePermission } = require('./middleware/security');
const { isKey } = require('./lib/permissions');

// Every route MUST declare access: 'public' | 'any' (any signed-in user) | P('permission', ...) (holds ANY of those permissions).
// The registry is exported so tests can prove every mutating endpoint is permission-checked.
module.exports = function makeApi() {
  const router = express.Router();
  const registry = [];
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const api = { router, registry, P: (...keys) => ({ permissions: keys }) };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    api[method] = (path, access, ...handlers) => {
      const ok = access === 'public' || access === 'any' || (access && Array.isArray(access.permissions) && access.permissions.length && access.permissions.every(isKey));
      if (!ok) throw new Error(`Route ${method.toUpperCase()} ${path} must declare access: 'public', 'any', or P(...known permissions)`);
      registry.push({ method: method.toUpperCase(), path: '/api' + path, access });
      const mw = [];
      if (access !== 'public') mw.push(requireAuth);
      if (access && access.permissions) mw.push(requirePermission(access.permissions));
      router[method](path, ...mw, ...handlers.map(wrap));
    };
  }
  return api;
};
