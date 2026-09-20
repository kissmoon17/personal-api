// This is the main entry point
// When you run 'node server.js', this file starts
// Why one file? It's the "master control" that starts everything

const express = require('express');
require('dotenv').config();

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
console.log('CORS headers set');
// Middleware: parse JSON from requests
// Why? If someone sends JSON data, we need to read it
app.use(express.json());

// Import the commits route (we'll create this next)
const commitsRoute = require('./routes/commits');

// Register the route
// What does this mean? 
// When someone calls GET /api/me/commits, 
// run the code in routes/commits.js
app.use('/api/me', commitsRoute);

const sleepRoute = require('./routes/sleep');
app.use('/api/me', sleepRoute);

const screenTimeRoute = require('./routes/screen-time');
app.use('/api/me', screenTimeRoute);

const dashboardRoute = require('./routes/dashboard');
app.use('/api/me', dashboardRoute);

// Health check endpoint
// Why? This lets us know the server is running
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Import the sync job
const { syncCommits } = require('./sync');

// Run sync immediately when server starts (for testing)
// Remove this in production
syncCommits();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ Test it: curl http://localhost:${PORT}/health`);
  console.log(`✓ Get commits: curl http://localhost:${PORT}/api/me/commits`);
});