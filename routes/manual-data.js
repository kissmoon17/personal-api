const db = require('../database');

module.exports = {
  // POST /api/me/sleep - add sleep data
  addSleep: async (req, res) => {
    try {
      const { date, hours_slept, quality, source } = req.body;
      
      if (!date || !hours_slept || !quality) {
        return res.status(400).json({ error: 'Missing required fields: date, hours_slept, quality' });
      }

      const result = await db.query(
        'INSERT INTO sleep (date, hours_slept, quality, source) VALUES ($1, $2, $3, $4) ON CONFLICT (date) DO UPDATE SET hours_slept=$2, quality=$3, source=$4 RETURNING *',
        [date, hours_slept, quality, source || 'manual']
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  // POST /api/me/screen-time - add screen time data
  addScreenTime: async (req, res) => {
    try {
      const { date, total_minutes, work_minutes, social_minutes, entertainment_minutes, source } = req.body;
      
      if (!date || !total_minutes) {
        return res.status(400).json({ error: 'Missing required fields: date, total_minutes' });
      }

      const result = await db.query(
        'INSERT INTO screen_time (date, total_minutes, work_minutes, social_minutes, entertainment_minutes, source) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (date) DO UPDATE SET total_minutes=$2, work_minutes=$3, social_minutes=$4, entertainment_minutes=$5, source=$6 RETURNING *',
        [date, total_minutes, work_minutes || 0, social_minutes || 0, entertainment_minutes || 0, source || 'manual']
      );

      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
};