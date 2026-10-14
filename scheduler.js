// The ONE place commit syncing is SCHEDULED.
//
// - Runs hourly, inside this server process (no sync on startup, no second scheduler).
// - Goes through sync-runner.js, which is also what the admin-only "Sync now" button uses,
//   so a manual sync and the hourly sync can never run at the same time.
// - node-cron runs once per running app instance, so keep the Railway service at
//   ONE replica, or set SYNC_SCHEDULER_ENABLED=false and use a Railway Cron service
//   instead (see README).
// - The button is a manual trigger, not a second schedule.

const SYNC_SCHEDULE = '0 * * * *'; // minute 0 of every hour

function isDisabled(value) {
  return ['false', '0', 'off', 'no'].includes(String(value ?? '').trim().toLowerCase());
}

// Dependencies are injectable so tests can verify behaviour without real timers or GitHub.
function startSyncScheduler({ cronLib, runner, env = process.env, logger = console } = {}) {
  if (isDisabled(env.SYNC_SCHEDULER_ENABLED)) {
    logger.log('Commit sync scheduler disabled (SYNC_SCHEDULER_ENABLED=false).');
    return null;
  }
  if (!runner) throw new Error('startSyncScheduler needs a sync runner');

  const cron = cronLib || require('node-cron');

  const task = cron.schedule(SYNC_SCHEDULE, async () => {
    const result = await runner.run('scheduled');
    if (result.status === 'busy') {
      logger.log('Previous commit sync still running; skipping this run.');
    }
  });

  logger.log(`Commit sync scheduled (cron "${SYNC_SCHEDULE}", hourly).`);
  return task;
}

module.exports = { SYNC_SCHEDULE, startSyncScheduler };
