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
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(f, new Date().toISOString());
    })();
    applied.push(f);
  }
  return applied;
}
module.exports = { open, migrate };
