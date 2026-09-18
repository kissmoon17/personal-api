const express = require('express');
const pool = require('../database');
const router = express.Router();

// GET /api/me/sleep
// Returns all sleep data
router.get('/sleep', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sleep ORDER BY date DESC LIMIT 30'
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching sleep:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch sleep data' 
    });
  }
});

// GET /api/me/sleep/stats
// Returns sleep statistics
router.get('/sleep/stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_nights,
        AVG(hours_slept) as avg_hours,
        AVG(quality) as avg_quality,
        MAX(hours_slept) as max_hours,
        MIN(hours_slept) as min_hours
      FROM sleep
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'`
    );

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching sleep stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch sleep stats' 
    });
  }
});

module.exports = router;