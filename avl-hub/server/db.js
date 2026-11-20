'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Plain-SQL migrations: migrations/NNN_name.sql, applied once, in order, each in a transaction.
function migrate(db, dir = path.join(__dirname, '..', 'migrations')) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  const applied = [];
  for (const f of fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const apply = () => db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(f, new Date().toISOString());
    })();
    if (/^--\s*migrate:\s*foreign-keys-off/m.test(sql.slice(0, 200))) {
      // SQLite can only change a table's constraints by rebuilding it, which needs foreign keys off while it happens.
      // The migration is still one transaction, and nothing is kept unless every foreign key checks out afterwards.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(sql);
          db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(f, new Date().toISOString());
          const bad = db.pragma('foreign_key_check');
          if (bad.length) throw new Error(`Migration ${f} would break ${bad.length} foreign key(s); nothing was changed.`);
        })();
      } finally { db.pragma('foreign_keys = ON'); }
    } else apply();
    applied.push(f);
  }
  return applied;
}
module.exports = { open, migrate };
