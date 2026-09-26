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
          parseFloat(screenTimeResult.rows[0]?.work_minutes) || 0
        ),
        wellbeing: calculateWellbeing(
          parseFloat(sleepResult.rows[0]?.hours_slept) || 0,
          parseFloat(sleepResult.rows[0]?.quality) || 0
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

    // Calculate productivity score based on daily averages
    // For multi-day periods, we score the daily average as if it were a single day
    const avgCommitsPerDay = parseInt(commitsResult.rows[0].count) / daysBack || 0;
    const avgWorkMinutesPerDay = parseFloat(screenResult.rows[0]?.avg_work) || 0;
    const productivityScore = calculateProductivity(
      Math.round(avgCommitsPerDay * 10) / 10, // Round to 1 decimal for fairness
      avgWorkMinutesPerDay
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
      },
      dailySummary: {
        productivity: productivityScore,
        wellbeing: calculateWellbeing(
          parseFloat(sleepResult.rows[0]?.avg_hours) || 0,
          parseFloat(sleepResult.rows[0]?.avg_quality) || 0
        )
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
/**
 * Calculate productivity score (0-100)
 * 
 * FORMULA (unified across all timeframes):
 * - Commit score: min(commits / 5 * 50, 50) — up to 5 commits = 50 points
 * - Work time score: min(workMinutes / 240 * 50, 50) — 4h work = 50 points
 * - Total: commitScore + workTimeScore, clamped to [0, 100]
 * 
 * ASSUMPTIONS:
 * - A productive day has ~5 commits and 4h (240 min) of focused work
 * - Both metrics contribute equally to productivity (50/50 split)
 * - Missing data (null) is treated as 0 contribution
 * - Results always clamp to [0, 100]
 * 
 * @param {number|null} commits - Number of commits (null = no data)
 * @param {number|null} workMinutes - Minutes spent on work (null = no data)
 * @returns {number|null} Score 0-100, or null if all data missing
 */
function calculateProductivity(commits, workMinutes) {
  // Treat null/undefined as 0
  commits = commits || 0;
  workMinutes = workMinutes || 0;

  // If both metrics are missing, return null
  if (commits === 0 && workMinutes === 0) {
    return null;
  }

  // Commit score: 0-50 (5 commits = 50 points)
  const commitScore = Math.min((commits / 5) * 50, 50);

  // Work time score: 0-50 (240 minutes = 50 points)
  const workScore = Math.min((workMinutes / 240) * 50, 50);

  // Total score, always between 0-100
  const totalScore = Math.round(commitScore + workScore);
  return Math.max(0, Math.min(100, totalScore));
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