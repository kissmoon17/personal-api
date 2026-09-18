const express = require('express');
const pool = require('../database');
const router = express.Router();

// GET /api/me/screen-time
// Returns all screen time data
router.get('/screen-time', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM screen_time ORDER BY date DESC LIMIT 30'
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching screen time:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch screen time data' 
    });
  }
});

// GET /api/me/screen-time/stats
// Returns screen time statistics
router.get('/screen-time/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        AVG(total_minutes) as avg_total,
        AVG(work_minutes) as avg_work,
        AVG(social_minutes) as avg_social,
        AVG(entertainment_minutes) as avg_entertainment,
        MAX(total_minutes) as max_total
      FROM screen_time
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'`
    );

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching screen time stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch screen time stats' 
    });
  }
});

module.exports = router;