'use strict';
// Server-side audit log. Call inside the same db.transaction as the change it records.
module.exports = function makeAudit(db) {
  const { editTime } = require('./lib/sync');
  const ins = db.prepare('INSERT INTO audit_log (ts,actor_id,actor_name,action,entity,entity_id,detail,ip) VALUES (?,?,?,?,?,?,?,?)');
  return function audit(req, action, entity, entityId, detail = {}, actorOverride = null) {
    const u = actorOverride || req.user || {};
    // For changes made offline, record when the person actually did it (separately from when it reached the server).
    if (req.get && req.get('x-edit-time')) detail = { ...detail, occurred_at: editTime(req) };
    ins.run(new Date().toISOString(), u.id || null, u.username || null, action, entity || null, entityId || null,
      JSON.stringify(detail), req.ip || null);
  };
};
