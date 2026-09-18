// This file handles /api/me/commits requests
// Why separate? Each endpoint gets its own file for organization

const express = require('express');
const pool = require('../database');
const router = express.Router();

// GET /api/me/commits
// What happens when someone calls this endpoint?
// 1. Query the database for commits
// 2. Return them as JSON
router.get('/commits', async (req, res) => {
  try {
    // Query the database
    // 'SELECT * FROM commits' means "give me all rows from commits table"
    // 'ORDER BY created_at DESC' means "newest first"
    // 'LIMIT 50' means "only 50 most recent"
    const result = await pool.query(
      'SELECT * FROM commits ORDER BY created_at DESC LIMIT 50'
    );

    // What is result.rows?
    // It's an array of commit objects from the database
    // Example: [{ id: 1, commit_hash: 'abc123...', message: 'Fix bug' }, ...]
    
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching commits:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch commits' 
    });
  }
});

// GET /api/me/commits/stats
// This endpoint returns stats about your commits
router.get('/commits/stats', async (req, res) => {
  try {
    // COUNT(*) = "how many rows total?"
    // This query counts commits and groups by date
    const result = await pool.query(
      `SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM commits
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30`
    );

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch stats' 
    });
  }
});

module.exports = router;