'use strict';
const { KEYS, SYSTEM_ROLES, subset } = require('./permissions');

// Looks roles and permissions up from the database on every request, so a change to a role takes effect immediately.
module.exports = function makeRoles(db) {
  const allKeys = () => new Set(KEYS);
  const permissionsOf = roleId => {
    if (roleId === 'admin') return allKeys();                      // always everything, including permissions added in later versions
    return new Set(db.prepare('SELECT permission FROM role_permissions WHERE role_id=?').all(roleId).map(r => r.permission).filter(p => KEYS.includes(p)));
  };
  const get = id => db.prepare('SELECT * FROM roles WHERE id=?').get(id);
  const list = () => db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all().map(r => ({ ...r, permissions: [...permissionsOf(r.id)].sort(),
    user_count: db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get(r.id).n }));
  // "No more power than you": every permission the target role has, the actor also has. Admin satisfies this for every role.
  const outranks = (actorPerms, roleId) => subset(permissionsOf(roleId), actorPerms);
  return { permissionsOf, get, list, outranks, SYSTEM_ROLES };
};
