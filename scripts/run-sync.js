// One-off commit sync, for a separate Railway Cron service (see README).
// Usage: node scripts/run-sync.js
// Only use this if you set SYNC_SCHEDULER_ENABLED=false on the web service.

require('dotenv').config();
const { syncCommits } = require('../sync');
const pool = require('../database');

syncCommits()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Sync run failed:', err && err.message);
    process.exit(1);
  });
