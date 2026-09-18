// This is the sync job
// It runs on a schedule (every night at 2 AM)
// Pulls commits from GitHub and saves to database

const axios = require('axios');
const cron = require('node-cron');
const pool = require('./database');
require('dotenv').config();

// Function to sync commits from GitHub
async function syncCommits() {
  try {
    console.log('🔄 Starting sync...');

    // Get all events for the user
    const eventsResponse = await axios.get(
      'https://api.github.com/users/kissmoon17/events',
      {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );

    // Filter for push events
    const pushEvents = eventsResponse.data.filter(event => 
      event.type === 'PushEvent'
    );

    console.log(`Found ${pushEvents.length} push events`);

    // For each push event, get the full commit details
    for (const event of pushEvents) {
      const repoOwner = event.repo.name.split('/')[0];
      const repoName = event.repo.name.split('/')[1];
      const commitHash = event.payload.head;

      try {
        // Get the full commit details from GitHub
        const commitResponse = await axios.get(
          `https://api.github.com/repos/${repoOwner}/${repoName}/commits/${commitHash}`,
          {
            headers: {
              'Authorization': `token ${process.env.GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json'
            }
          }
        );

        const commit = commitResponse.data.commit;
        
        console.log('Inserting commit:', commitHash, commit.message);

        // Save to database
        await pool.query(
          `INSERT INTO commits (commit_hash, message, author, created_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (commit_hash) DO NOTHING`,
          [
            commitHash,
            commit.message,
            commit.author.name,
            new Date(commit.author.date)
          ]
        );
      } catch (err) {
        console.error('Error fetching/inserting commit:', err.message);
      }
    }

    console.log('✓ Sync complete');
  } catch (error) {
    console.error('Sync error:', error.message);
  }
}

// Schedule the sync job
// What does this mean?
// Run syncCommits() every day at 2 AM
// '0 2 * * *' is cron syntax:
//   0 = minute 0
//   2 = hour 2
//   * = any day
//   * = any month
//   * = any weekday

cron.schedule('0 2 * * *', syncCommits);

// For testing, also run every hour so you don't wait
cron.schedule('0 * * * *', syncCommits);

console.log('✓ Sync job scheduled');
console.log('  - Every hour (testing)');
console.log('  - Every day at 2 AM (production)');

module.exports = { syncCommits };