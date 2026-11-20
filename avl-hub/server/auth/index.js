'use strict';
const makeSessions = require('./sessions');
const localProvider = require('./local');
const oidcProvider = require('./oidc.stub');

// The rest of the app depends only on { provider, sessions }.
module.exports = function createAuth(ctx) {
  const sessions = makeSessions(ctx.db, ctx.config);
  const provider = ctx.config.authProvider === 'oidc' ? oidcProvider(ctx) : localProvider(ctx);
  return { provider, sessions };
};
