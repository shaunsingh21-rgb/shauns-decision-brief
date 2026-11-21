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
  const files = fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  // DOWNGRADE GUARD: older code must never open a database that a newer version has upgraded. (Proven in testing: the pre-roles code ran on a
  // current database and silently skipped two-step sign-in.) Set AVL_ALLOW_NEWER_SCHEMA=1 only on the developer's say-so.
  const newer = [...done].filter(n => !files.includes(n));
  if (newer.length && !process.env.AVL_ALLOW_NEWER_SCHEMA) {
    const e = new Error(`This database was upgraded by a NEWER version of AVL Hub (it contains ${newer.join(', ')}, which this copy does not know). Refusing to start so nothing is damaged. Update the app to the newer version, or restore a backup made by this version.`);
    e.code = 'SCHEMA_TOO_NEW'; throw e;
  }
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // RACE GUARD: two copies starting at once (a restart overlapping the old process) must not both apply the same file.
    // The transaction takes the write lock FIRST (.immediate()) and re-checks inside it; the loser simply skips.
    const already = () => db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(f);
    let skipped = false;
    const apply = () => db.transaction(() => {
      if (already()) { skipped = true; return; }
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(f, new Date().toISOString());
    }).immediate();
    if (/^--\s*migrate:\s*foreign-keys-off/m.test(sql.slice(0, 200))) {
      // SQLite can only change a table's constraints by rebuilding it, which needs foreign keys off while it happens.
      // The migration is still one transaction, and nothing is kept unless every foreign key checks out afterwards.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          if (already()) { skipped = true; return; }
          db.exec(sql);
          db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(f, new Date().toISOString());
          const bad = db.pragma('foreign_key_check');
          if (bad.length) throw new Error(`Migration ${f} would break ${bad.length} foreign key(s); nothing was changed.`);
        }).immediate();
      } finally { db.pragma('foreign_keys = ON'); }
    } else apply();
    if (!skipped) applied.push(f);
  }
  return applied;
}
module.exports = { open, migrate };
