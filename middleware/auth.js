// Admin authentication for every request that changes data.
//
// How it works:
//  - Reads (GET/HEAD/OPTIONS) are public so the dashboard loads without a login.
//  - Anything else (POST/PUT/PATCH/DELETE) must send:  Authorization: Bearer <ADMIN_API_TOKEN>
//  - The token lives ONLY in the server environment (Railway Variables / local .env).
//  - Fail closed: if ADMIN_API_TOKEN is missing or too short, every write is refused.

const crypto = require('crypto');

const MIN_TOKEN_LENGTH = 32;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let warnedAboutConfig = false;

// Returns the configured token, or null if it is missing / too short.
// Read at request time (not import time) so a changed variable is always honoured.
function getConfiguredToken(env = process.env) {
  const token = (env.ADMIN_API_TOKEN || '').trim();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

// Hash both values first so timingSafeEqual always compares equal-length buffers
// (it throws on different lengths, and a length check would leak timing info).
function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function tokensMatch(provided, expected) {
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

// "Bearer abc123" -> "abc123". Anything else -> null.
function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer +(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

function requireAdminToken(req, res, next) {
  const expected = getConfiguredToken();

  if (!expected) {
    if (!warnedAboutConfig) {
      warnedAboutConfig = true;
      console.error(
        `ADMIN_API_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters. ` +
        'All write requests are being refused until it is set.'
      );
    }
    return res.status(503).json({
      success: false,
      error: 'Write access is disabled: the server is not configured for it.'
    });
  }

  const provided = extractBearerToken(req.get('authorization'));
  if (!provided || !tokensMatch(provided, expected)) {
    res.set('WWW-Authenticate', 'Bearer realm="personal-api"');
    return res.status(401).json({ success: false, error: 'A valid admin token is required.' });
  }

  next();
}

// Global guard: protects ALL non-read methods, including routes added in the future.
function requireAdminForWrites(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  return requireAdminToken(req, res, next);
}

module.exports = {
  MIN_TOKEN_LENGTH,
  getConfiguredToken,
  extractBearerToken,
  requireAdminToken,
  requireAdminForWrites
};
