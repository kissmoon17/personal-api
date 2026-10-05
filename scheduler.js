// The ONE place commit syncing is scheduled.
//
// - Runs hourly, inside this server process (no sync on startup, no second scheduler).
// - node-cron runs once per running app instance, so keep the Railway service at
//   ONE replica, or set SYNC_SCHEDULER_ENABLED=false and use a Railway Cron service
//   instead (see README).
// - There is deliberately no HTTP endpoint that triggers a sync.

const SYNC_SCHEDULE = '0 * * * *'; // minute 0 of every hour

function isDisabled(value) {
  return ['false', '0', 'off', 'no'].includes(String(value ?? '').trim().toLowerCase());
}

// Dependencies are injectable so tests can verify behaviour without real timers or GitHub.
function startSyncScheduler({ cronLib, sync, env = process.env, logger = console } = {}) {
  if (isDisabled(env.SYNC_SCHEDULER_ENABLED)) {
    logger.log('Commit sync scheduler disabled (SYNC_SCHEDULER_ENABLED=false).');
    return null;
  }

  const cron = cronLib || require('node-cron');
  const syncCommits = sync || require('./sync').syncCommits;
  let running = false;

  const task = cron.schedule(SYNC_SCHEDULE, async () => {
    if (running) {
      logger.log('Previous commit sync still running; skipping this run.');
      return;
    }
    running = true;
    try {
      logger.log('Running scheduled commit sync...');
      await syncCommits();
    } catch (err) {
      logger.error('Scheduled commit sync failed:', err && err.message);
    } finally {
      running = false;
    }
  });

  logger.log(`Commit sync scheduled (cron "${SYNC_SCHEDULE}", hourly).`);
  return task;
}

module.exports = { SYNC_SCHEDULE, startSyncScheduler };
