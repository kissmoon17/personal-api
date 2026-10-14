// Runs the commit sync, and makes sure only ONE sync runs at a time in this process.
// Both the hourly schedule (scheduler.js) and the "Sync now" button
// (POST /api/me/sync, admin token required) go through the same runner, so they can
// never overlap, and the button has a short cooldown so it can't burn GitHub's rate limit.

const DEFAULT_COOLDOWN_MS = 60 * 1000;

function describeError(err) {
  if (!err) return 'unknown error';
  // Some errors (like a refused database connection) have an empty message.
  return err.message || err.code || (err.errors && err.errors[0] && err.errors[0].code) || 'unknown error';
}

// Dependencies are injectable so tests can run without GitHub, timers, or a database.
function createSyncRunner({ sync, logger = console, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now }) {
  let running = false;
  let lastFinishedAt = null;

  // trigger: 'scheduled' (hourly job) or 'manual' (button). Only manual runs have a cooldown.
  // Never throws. Resolves to one of:
  //   { status: 'done', summary, durationMs } | { status: 'failed' }
  //   { status: 'busy' } | { status: 'cooldown', retryAfterSeconds }
  async function run(trigger = 'manual') {
    if (running) return { status: 'busy' };

    if (trigger === 'manual' && lastFinishedAt !== null) {
      const waitMs = cooldownMs - (now() - lastFinishedAt);
      if (waitMs > 0) return { status: 'cooldown', retryAfterSeconds: Math.ceil(waitMs / 1000) };
    }

    running = true;
    const startedAt = now();
    try {
      logger.log(`Running ${trigger} commit sync...`);
      const summary = await sync();
      return { status: 'done', summary, durationMs: now() - startedAt };
    } catch (err) {
      logger.error(`${trigger} commit sync failed:`, describeError(err));
      return { status: 'failed' };
    } finally {
      running = false;
      lastFinishedAt = now();
    }
  }

  return { run, isRunning: () => running };
}

module.exports = { DEFAULT_COOLDOWN_MS, createSyncRunner, describeError };
