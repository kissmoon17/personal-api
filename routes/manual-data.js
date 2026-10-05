const db = require('../database');
const { validateSleepInput, validateScreenTimeInput } = require('../lib/validation');

// These handlers only run after the admin token check in middleware/auth.js.
module.exports = {
  // POST /api/me/sleep - add sleep data
  addSleep: async (req, res) => {
    const { ok, errors, value } = validateSleepInput(req.body);
    if (!ok) {
      return res.status(400).json({ success: false, error: 'Invalid input', details: errors });
    }

    try {
      const result = await db.query(
        'INSERT INTO sleep (date, hours_slept, quality, source) VALUES ($1, $2, $3, $4) ON CONFLICT (date) DO UPDATE SET hours_slept=$2, quality=$3, source=$4 RETURNING *',
        [value.date, value.hours_slept, value.quality, value.source]
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      // Log the real reason on the server only; never send raw database errors to clients.
      console.error('Error saving sleep data:', error.message);
      res.status(500).json({ success: false, error: 'Failed to save sleep data' });
    }
  },

  // POST /api/me/screen-time - add screen time data
  addScreenTime: async (req, res) => {
    const { ok, errors, value } = validateScreenTimeInput(req.body);
    if (!ok) {
      return res.status(400).json({ success: false, error: 'Invalid input', details: errors });
    }

    try {
      const result = await db.query(
        'INSERT INTO screen_time (date, total_minutes, work_minutes, social_minutes, entertainment_minutes, source) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (date) DO UPDATE SET total_minutes=$2, work_minutes=$3, social_minutes=$4, entertainment_minutes=$5, source=$6 RETURNING *',
        [value.date, value.total_minutes, value.work_minutes, value.social_minutes, value.entertainment_minutes, value.source]
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error('Error saving screen time data:', error.message);
      res.status(500).json({ success: false, error: 'Failed to save screen time data' });
    }
  }
};