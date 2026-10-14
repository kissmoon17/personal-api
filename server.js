// This is the main entry point
// When you run 'node server.js', this file starts
// Why one file? It's the "master control" that starts everything
// (The routes and middleware live in app.js so the tests can load them
// without starting a server or a scheduler.)

require('dotenv').config();

const { createApp } = require('./app');
const { startSyncScheduler } = require('./scheduler');
const { createSyncRunner } = require('./sync-runner');
const { syncCommits } = require('./sync');
const { getConfiguredToken, MIN_TOKEN_LENGTH } = require('./middleware/auth');

// ONE runner shared by the hourly schedule and the admin-only "Sync now" button,
// so the two can never run at the same time.
const syncRunner = createSyncRunner({ sync: syncCommits });

const app = createApp({ syncRunner });

// Fail closed, but keep the public read-only dashboard up.
if (!getConfiguredToken()) {
  console.warn(
    `WARNING: ADMIN_API_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters. ` +
    'The dashboard can be viewed, but every write request will be refused.'
  );
}

// The single, server-side commit sync schedule (hourly). No sync on startup.
// (The "Sync now" button is a manual trigger, not a second schedule.)
startSyncScheduler({ runner: syncRunner });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ Test it: curl http://localhost:${PORT}/health`);
  console.log(`✓ Get commits: curl http://localhost:${PORT}/api/me/commits`);
});