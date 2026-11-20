'use strict';
const loadConfig = require('./config');
const { open, migrate } = require('./db');
if (require.main === module) {
  const db = open(loadConfig().dbPath);
  const a = migrate(db);
  console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date.');
}
