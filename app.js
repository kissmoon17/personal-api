// Builds the Express app (routes + middleware) WITHOUT starting a server or any
// scheduled jobs. server.js starts it; the tests import it directly.
// Why a factory? Each call gives a fresh app that re-reads CORS_ORIGINS.

const path = require('path');
const express = require('express');

const { corsMiddleware } = require('./middleware/cors');
const { requireAdminForWrites } = require('./middleware/auth');

function createApp() {
  const app = express();

  // 1. CORS: which *browser* origins may read responses (not authentication!)
  app.use(corsMiddleware());

  // 2. Admin guard: every POST/PUT/PATCH/DELETE needs the Bearer token.
  //    It runs before body parsing so unauthenticated bodies are never processed,
  //    and it covers routes added in the future by default.
  app.use(requireAdminForWrites);

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Middleware: parse JSON from requests (small limit: our payloads are tiny)
  app.use(express.json({ limit: '10kb' }));

  // PUBLIC READ routes (GET): anyone can read this data. See README.
  const commitsRoute = require('./routes/commits');
  app.use('/api/me', commitsRoute);

  const sleepRoute = require('./routes/sleep');
  app.use('/api/me', sleepRoute);

  const screenTimeRoute = require('./routes/screen-time');
  app.use('/api/me', screenTimeRoute);

  const dashboardRoute = require('./routes/dashboard');
  app.use('/api/me', dashboardRoute);

  // PROTECTED WRITE routes (the admin guard above runs first)
  const manualDataRoute = require('./routes/manual-data');
  app.post('/api/me/sleep', manualDataRoute.addSleep);
  app.post('/api/me/screen-time', manualDataRoute.addScreenTime);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'Server is running' });
  });

  // Error handler: clients get short generic JSON, never stack traces or raw errors.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, error: 'Request body must be valid JSON.' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ success: false, error: 'Request body is too large.' });
    }
    console.error('Unhandled error:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
