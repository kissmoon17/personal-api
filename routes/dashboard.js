const express = require('express');
const pool = require('../database');
const router = express.Router();

// GET /api/me/today
// Returns a unified dashboard of all data for today
router.get('/today', async (req, res) => {
  try {
    // Get today's date in Nepal timezone
    const nepalDate = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kathmandu' }).split(' ')[0];

    // Get today's commits
    const commitsResult = await pool.query(
      `SELECT COUNT(*) as count, 
              STRING_AGG(message, ', ') as messages
       FROM commits 
       WHERE DATE(created_at AT TIME ZONE 'UTC'+INTERVAL '5:45') = $1::date`,
      [nepalDate]
    );

    // Get today's sleep data
    const sleepResult = await pool.query(
      `SELECT hours_slept, quality, source 
       FROM sleep 
       WHERE DATE(date) = $1::date`,
      [nepalDate]
    );

    // Get today's screen time data
    const screenTimeResult = await pool.query(
      `SELECT total_minutes, work_minutes, social_minutes, entertainment_minutes, source 
       FROM screen_time 
       WHERE DATE(date) = $1::date`,
      [nepalDate]
    );

    // Build the unified response
    const dashboard = {
      success: true,
      date: new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kathmandu' }).split(' ')[0],
      summary: {
        commits: {
          count: parseInt(commitsResult.rows[0].count) || 0,
          messages: commitsResult.rows[0].messages || "No commits today"
        },
        sleep: sleepResult.rows[0] || {
          hours_slept: null,
          quality: null,
          source: "Not tracked"
        },
        screenTime: screenTimeResult.rows[0] || {
          total_minutes: null,
          work_minutes: null,
          social_minutes: null,
          entertainment_minutes: null,
          source: "Not tracked"
        }
      },
      // Why this summary?
      // It gives a quick overview of your day at a glance
      // Useful for dashboards, mobile apps, etc
      dailySummary: {
        productivity: calculateProductivity(
          parseInt(commitsResult.rows[0].count) || 0,
          screenTimeResult.rows[0]?.work_minutes || 0
        ),
        wellbeing: calculateWellbeing(
          sleepResult.rows[0]?.hours_slept || 0,
          sleepResult.rows[0]?.quality || 0
        )
      }
    };

    res.json(dashboard);
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch dashboard data' 
    });
  }
});

// GET /api/me/timeframe?period=7days
// Returns aggregated data for the selected timeframe
router.get('/timeframe', async (req, res) => {
  try {
    const period = req.query.period || '1day';
    let daysBack = 1;
    
    if (period === '7days') daysBack = 7;
    if (period === '30days') daysBack = 30;
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    
    // Get commits for period
    const commitsResult = await pool.query(
      `SELECT COUNT(*) as count, 
              STRING_AGG(message, ', ') as messages
       FROM commits 
       WHERE DATE(created_at AT TIME ZONE 'UTC'+INTERVAL '5:45') >= $1::date`,
      [startDate.toISOString().split('T')[0]]
    );

    // Get sleep average
    const sleepResult = await pool.query(
      `SELECT AVG(CAST(hours_slept AS FLOAT)) as avg_hours,
              AVG(CAST(quality AS FLOAT)) as avg_quality,
              COUNT(*) as days_logged
       FROM sleep 
       WHERE DATE(date) >= $1::date`,
      [startDate.toISOString().split('T')[0]]
    );

    // Get screen time average
    const screenResult = await pool.query(
      `SELECT AVG(CAST(total_minutes AS INT)) as avg_total,
              AVG(CAST(work_minutes AS INT)) as avg_work,
              AVG(CAST(social_minutes AS INT)) as avg_social,
              AVG(CAST(entertainment_minutes AS INT)) as avg_entertainment,
              COUNT(*) as days_logged
       FROM screen_time 
       WHERE DATE(date) >= $1::date`,
      [startDate.toISOString().split('T')[0]]
    );

    const response = {
      success: true,
      period: period,
      summary: {
        commits: {
          count: parseInt(commitsResult.rows[0].count) || 0,
          messages: commitsResult.rows[0].messages || "No commits"
        },
        sleep: sleepResult.rows[0] || {
          avg_hours: null,
          avg_quality: null,
          days_logged: 0
        },
        screenTime: screenResult.rows[0] || {
          avg_total: null,
          avg_work: null,
          avg_social: null,
          avg_entertainment: null,
          days_logged: 0
        }
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching timeframe data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch timeframe data' 
    });
  }
});
// Helper function to calculate productivity score
// Why? To give a simple score based on commits and work time
function calculateProductivity(commits, workMinutes) {
  let score = 0;
  
  // Commits contribute to score
  if (commits > 0) score += 30;
  if (commits > 2) score += 20;
  if (commits > 5) score += 20;
  
  // Work screen time contributes
  if (workMinutes > 120) score += 30;
  if (workMinutes > 240) score += 20;
  
  return Math.min(100, score); // Cap at 100
}

// Helper function to calculate wellbeing score
// Why? To give insight into health based on sleep
function calculateWellbeing(hourSlept, quality) {
  let score = 0;
  
  // Sleep hours
  if (hourSlept >= 7 && hourSlept <= 9) score += 50;
  else if (hourSlept >= 6 && hourSlept < 10) score += 30;
  
  // Sleep quality
  if (quality >= 0.8) score += 50;
  else if (quality >= 0.6) score += 30;
  
  return Math.min(100, score); // Cap at 100
}

module.exports = router;