// This is the sync job
// It is scheduled in ONE place only: scheduler.js (started by server.js)
// Pulls commits from GitHub and saves to database

const axios = require('axios');
const pool = require('./database');
require('dotenv').config();

// Function to sync commits from GitHub
async function syncCommits() {
  try {
    console.log('🔄 Starting sync...');

    // Get all user repos
    const reposResponse = await axios.get(
      'https://api.github.com/users/kissmoon17/repos',
      {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        params: {
          per_page: 100,
          sort: 'updated'
        }
      }
    );

    console.log(`Found ${reposResponse.data.length} repos`);

    // For each repo, fetch commits
    for (const repo of reposResponse.data) {
      try {
        const commitsResponse = await axios.get(
          `https://api.github.com/repos/kissmoon17/${repo.name}/commits`,
          {
            headers: {
              'Authorization': `token ${process.env.GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json'
            },
            params: {
              per_page: 100
            }
          }
        );

        console.log(`Found ${commitsResponse.data.length} commits in ${repo.name}`);

        // Save each commit to database
        for (const commit of commitsResponse.data) {
          try {
            await pool.query(
              `INSERT INTO commits (commit_hash, message, author, created_at)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (commit_hash) DO NOTHING`,
              [
                commit.sha,
                commit.commit.message,
                commit.commit.author.name,
                new Date(commit.commit.author.date)
              ]
            );
          } catch (err) {
            console.error('Error inserting commit:', err.message);
          }
        }
      } catch (err) {
        console.error(`Error fetching commits from ${repo.name}:`, err.message);
      }
    }

    console.log('✓ Sync complete');
  } catch (error) {
    console.error('Sync error:', error.message);
  }
}

module.exports = { syncCommits };