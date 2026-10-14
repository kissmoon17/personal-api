// This is the sync job
// It is scheduled in ONE place only: scheduler.js (started by server.js).
// It can also be started by the admin-only "Sync now" button (POST /api/me/sync).
// Both go through sync-runner.js, so two syncs never run at the same time.
// Pulls commits from GitHub and saves to database

const axios = require('axios');
const pool = require('./database');
const { describeError } = require('./sync-runner');
require('dotenv').config();

// Function to sync commits from GitHub.
// Returns counts: { repos, fetched, inserted, alreadySaved, failed }
// Throws if GitHub's repo list can't be fetched at all.
async function syncCommits() {
  console.log('🔄 Starting sync...');

  const summary = { repos: 0, fetched: 0, inserted: 0, alreadySaved: 0, failed: 0 };
  let firstSaveError = null;

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

  summary.repos = reposResponse.data.length;
  console.log(`Found ${summary.repos} repos`);

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
      summary.fetched += commitsResponse.data.length;

      // Save each commit to database
      for (const commit of commitsResponse.data) {
        try {
          const result = await pool.query(
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
          if (result.rowCount > 0) summary.inserted++;
          else summary.alreadySaved++;
        } catch (err) {
          summary.failed++;
          // Log the real reason once, not once per commit.
          if (!firstSaveError) {
            firstSaveError = describeError(err);
            console.error('Error inserting commit:', firstSaveError);
          }
        }
      }
    } catch (err) {
      console.error(`Error fetching commits from ${repo.name}:`, describeError(err));
    }
  }

  console.log(
    `Sync finished: ${summary.inserted} new, ${summary.alreadySaved} already saved, ${summary.failed} failed to save`
  );
  return summary;
}

module.exports = { syncCommits };