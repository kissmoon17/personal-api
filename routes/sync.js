// POST /api/me/sync  ->  "Sync now" button.
// NOT public: the global admin guard (middleware/auth.js) rejects it without the
// Bearer token before this handler ever runs. There is no GET version.

function createSyncHandler(runner) {
  return async (req, res) => {
    try {
      const result = await runner.run('manual');

      if (result.status === 'busy') {
        return res.status(409).json({ success: false, error: 'A sync is already running. Try again in a moment.' });
      }

      if (result.status === 'cooldown') {
        const seconds = result.retryAfterSeconds;
        res.set('Retry-After', String(seconds));
        return res.status(429).json({
          success: false,
          error: `A sync just ran. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
          retry_after_seconds: seconds
        });
      }

      if (result.status === 'failed') {
        // Real reason is in the server logs; clients only get a generic message.
        return res.status(502).json({ success: false, error: 'Sync failed. Check the server logs for details.' });
      }

      // Only numbers are returned, never error text.
      const s = result.summary || {};
      return res.json({
        success: true,
        data: {
          repos: s.repos || 0,
          fetched: s.fetched || 0,
          inserted: s.inserted || 0,
          already_saved: s.alreadySaved || 0,
          failed: s.failed || 0,
          duration_ms: result.durationMs
        }
      });
    } catch (err) {
      console.error('Sync route error:', err && err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createSyncHandler };
