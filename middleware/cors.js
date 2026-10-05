// CORS allow-list.
//
// IMPORTANT: CORS is NOT authentication. It only tells *browsers* which websites
// may read responses from this API. Anyone can still call the public GET
// endpoints with curl or a script. Write protection comes from middleware/auth.js.
//
// The dashboard is served by this same server, so its requests are same-origin
// and don't need CORS at all. CORS_ORIGINS is only for dashboards hosted elsewhere
// (e.g. http://localhost:3000 while developing).

const cors = require('cors');

// The dashboard origin this project already uses (see API_URL in public/index.html).
const DEFAULT_ORIGINS = ['https://personal-api-production-aaef.up.railway.app'];

// Turns "https://a.com, http://localhost:3000/" into ["https://a.com", "http://localhost:3000"].
// Invalid entries (and "*") are dropped, so a typo can only make CORS stricter.
function parseCorsOrigins(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return [...DEFAULT_ORIGINS];
  }

  const origins = [];
  for (const item of String(raw).split(',')) {
    const value = item.trim();
    if (!value) continue;

    if (value === '*') {
      console.warn('CORS_ORIGINS: "*" is not allowed and was ignored. List exact origins instead.');
      continue;
    }

    let url;
    try {
      url = new URL(value);
    } catch (err) {
      console.warn(`CORS_ORIGINS: ignored invalid entry "${value}"`);
      continue;
    }

    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    const isBareOrigin = url.pathname === '/' && !url.search && !url.hash;
    if (!isHttp || !isBareOrigin) {
      console.warn(`CORS_ORIGINS: ignored "${value}" (must look like https://example.com)`);
      continue;
    }

    origins.push(url.origin);
  }

  return origins;
}

function corsMiddleware(env = process.env) {
  const allowed = new Set(parseCorsOrigins(env.CORS_ORIGINS));

  return cors({
    // Same-origin and non-browser requests have no Origin header: no CORS headers needed.
    origin(origin, callback) {
      callback(null, Boolean(origin) && allowed.has(origin));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false, // we use a Bearer header, never cookies
    maxAge: 600,
    optionsSuccessStatus: 204
  });
}

module.exports = { DEFAULT_ORIGINS, parseCorsOrigins, corsMiddleware };
