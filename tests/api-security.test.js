// Security + validation tests. Run with: npm test
//
// Safe by design: the database module is replaced with an in-memory fake BEFORE
// the app loads, so nothing here touches PostgreSQL, GitHub, .env, or production.
// Uses Node's built-in test runner (no extra dependencies).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_TOKEN = 'unit-test-token-'.padEnd(48, 'x'); // fixture only, not a real secret
const OTHER_TOKEN = 'a-different-token-'.padEnd(48, 'y');

// ---- fake database -------------------------------------------------------
const fakeDb = {
  calls: [],
  handler: null,
  reset() {
    this.calls = [];
    this.handler = defaultHandler;
  },
  async query(sql, params) {
    this.calls.push({ sql, params });
    return this.handler(sql, params);
  },
  writes() {
    return this.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));
  }
};

function defaultHandler(sql, params) {
  if (/^\s*INSERT/i.test(sql)) {
    return { rows: [{ id: 1, date: params[0] }] };
  }
  if (/COUNT\(\*\)/i.test(sql)) {
    return { rows: [{ count: '3', messages: 'one, two', total: '3' }] };
  }
  return { rows: [] };
}

const dbPath = require.resolve(path.join(ROOT, 'database.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { createApp } = require('../app');
const { startSyncScheduler, SYNC_SCHEDULE } = require('../scheduler');
const { parseCorsOrigins, DEFAULT_ORIGINS } = require('../middleware/cors');
const { validateSleepInput, validateScreenTimeInput } = require('../lib/validation');

// ---- helpers ---------------------------------------------------------------
let server;
let base;
const savedEnv = {};

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startServer() {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}

const bearer = (token = TEST_TOKEN) => ({ Authorization: `Bearer ${token}` });

function post(url, body, headers = {}) {
  return fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

const goodSleep = { date: '2026-09-20', hours_slept: 7.5, quality: 0.5, source: 'manual' };
const goodScreen = { date: '2026-09-20', total_minutes: 300, work_minutes: 200, entertainment_minutes: 100, source: 'manual' };

beforeEach(async () => {
  fakeDb.reset();
  setEnv({ ADMIN_API_TOKEN: TEST_TOKEN, CORS_ORIGINS: undefined });
  await startServer();
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---- token handling --------------------------------------------------------
describe('admin token on write routes', () => {
  const routes = [
    ['/api/me/sleep', goodSleep],
    ['/api/me/screen-time', goodScreen]
  ];

  for (const [url, body] of routes) {
    test(`POST ${url}: missing token -> 401 and nothing written`, async () => {
      const res = await post(url, body);
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate') || '', /^Bearer/);
      assert.equal(fakeDb.writes().length, 0);
    });

    test(`POST ${url}: wrong token -> 401 and nothing written`, async () => {
      const res = await post(url, body, bearer(OTHER_TOKEN));
      assert.equal(res.status, 401);
      assert.equal(fakeDb.writes().length, 0);
    });

    test(`POST ${url}: wrong-length / malformed credentials -> 401`, async () => {
      for (const header of ['Bearer short', 'Bearer', 'Bearer ', `Basic ${TEST_TOKEN}`, TEST_TOKEN, `Bearer ${TEST_TOKEN}extra`]) {
        const res = await post(url, body, { Authorization: header });
        assert.equal(res.status, 401, `header "${header.slice(0, 20)}..." should be rejected`);
      }
      assert.equal(fakeDb.writes().length, 0);
    });

    test(`POST ${url}: token in query string or body is NOT accepted`, async () => {
      const res = await post(`${url}?token=${TEST_TOKEN}`, { ...body, token: TEST_TOKEN, ADMIN_API_TOKEN: TEST_TOKEN });
      assert.equal(res.status, 401);
      assert.equal(fakeDb.writes().length, 0);
    });

    test(`POST ${url}: valid token -> 200 and exactly one write`, async () => {
      const res = await post(url, body, bearer());
      assert.equal(res.status, 200);
      assert.equal((await res.json()).success, true);
      assert.equal(fakeDb.writes().length, 1);
    });
  }

  test('scheme name is case-insensitive ("bearer <token>")', async () => {
    const res = await post('/api/me/sleep', goodSleep, { Authorization: `bearer ${TEST_TOKEN}` });
    assert.equal(res.status, 200);
  });

  test('PUT, PATCH, DELETE are guarded on every API path; unknown paths too', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const url of ['/api/me/sleep', '/api/me/screen-time', '/api/me/commits', '/api/me/anything-new', '/api/anything']) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 401, `${method} ${url} must require the token`);
      }
    }
    assert.equal(fakeDb.writes().length, 0);
  });

  test('with a valid token, unsupported write methods do not reach the database', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(base + '/api/me/sleep', {
        method,
        headers: { 'Content-Type': 'application/json', ...bearer() },
        body: JSON.stringify(goodSleep)
      });
      assert.equal(res.status, 404, `${method} has no handler`);
    }
    assert.equal(fakeDb.writes().length, 0);
  });

  test('ADMIN_API_TOKEN missing -> writes fail closed (503), even with a token', async () => {
    setEnv({ ADMIN_API_TOKEN: undefined });
    for (const headers of [{}, bearer(), bearer('')]) {
      const res = await post('/api/me/sleep', goodSleep, headers);
      assert.equal(res.status, 503);
    }
    assert.equal(fakeDb.writes().length, 0);
  });

  test('ADMIN_API_TOKEN too short -> writes fail closed even if the client sends the same short value', async () => {
    setEnv({ ADMIN_API_TOKEN: 'short-secret' });
    const res = await post('/api/me/sleep', goodSleep, bearer('short-secret'));
    assert.equal(res.status, 503);
    assert.equal(fakeDb.writes().length, 0);
  });

  test('ADMIN_API_TOKEN of only spaces -> fail closed', async () => {
    setEnv({ ADMIN_API_TOKEN: ' '.repeat(64) });
    const res = await post('/api/me/sleep', goodSleep, bearer(' '));
    assert.equal(res.status, 503);
  });

  test('reads still work when ADMIN_API_TOKEN is missing', async () => {
    setEnv({ ADMIN_API_TOKEN: undefined });
    const res = await fetch(base + '/api/me/commits');
    assert.equal(res.status, 200);
  });

  test('error responses never echo the token', async () => {
    const res = await post('/api/me/sleep', goodSleep, bearer(OTHER_TOKEN));
    const text = await res.text();
    assert.ok(!text.includes(OTHER_TOKEN) && !text.includes(TEST_TOKEN));
  });
});

// ---- public reads ------------------------------------------------------------
describe('public read routes', () => {
  const reads = [
    '/health',
    '/api/me/commits',
    '/api/me/commits/stats',
    '/api/me/sleep',
    '/api/me/sleep/stats',
    '/api/me/screen-time',
    '/api/me/screen-time/stats',
    '/api/me/today',
    '/api/me/timeframe?period=7days',
    '/api/me/timeframe?period=30days'
  ];

  for (const url of reads) {
    test(`GET ${url} works with no Authorization header`, async () => {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, `${url} should be public`);
    });
  }

  test('GET / serves the dashboard without a login', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Personal/);
  });

  test('HEAD requests are public too', async () => {
    const res = await fetch(base + '/api/me/commits', { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  test('reads never write to the database', async () => {
    for (const url of reads) await (await fetch(base + url)).text();
    assert.equal(fakeDb.writes().length, 0);
  });
});

// ---- sync endpoint removed -----------------------------------------------------
describe('public sync endpoint removed', () => {
  test('GET /api/sync is gone (404) and triggers nothing', async () => {
    const res = await fetch(base + '/api/sync');
    assert.equal(res.status, 404);
    assert.equal(fakeDb.calls.length, 0);
  });

  test('POST /api/sync needs the token, and still does not exist with it', async () => {
    assert.equal((await post('/api/sync', {})).status, 401);
    assert.equal((await post('/api/sync', {}, bearer())).status, 404);
  });

  test('no route in the source tree exposes a sync trigger', () => {
    for (const file of ['app.js', 'server.js', ...fs.readdirSync(path.join(ROOT, 'routes')).map((f) => `routes/${f}`)]) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/['"`]\/api\/sync['"`]/.test(src), `${file} must not define /api/sync`);
      assert.ok(!/require\(['"]\.\.?\/sync['"]\)/.test(src), `${file} must not import sync directly`);
    }
  });
});

// ---- exactly one scheduler ---------------------------------------------------------
describe('commit sync scheduling', () => {
  function fakeCron() {
    const jobs = [];
    return { jobs, schedule(expr, fn) { jobs.push({ expr, fn }); return { stop() {} }; } };
  }

  test('registers exactly one hourly job and does NOT sync on startup', async () => {
    const cron = fakeCron();
    let syncCalls = 0;
    startSyncScheduler({ cronLib: cron, sync: async () => { syncCalls++; }, env: {}, logger: { log() {}, error() {} } });
    assert.equal(cron.jobs.length, 1);
    assert.equal(cron.jobs[0].expr, SYNC_SCHEDULE);
    assert.equal(SYNC_SCHEDULE, '0 * * * *');
    assert.equal(syncCalls, 0, 'no sync at startup');
    await cron.jobs[0].fn();
    assert.equal(syncCalls, 1);
  });

  test('SYNC_SCHEDULER_ENABLED=false registers nothing', () => {
    for (const value of ['false', 'FALSE', '0', 'off']) {
      const cron = fakeCron();
      const task = startSyncScheduler({ cronLib: cron, sync: async () => {}, env: { SYNC_SCHEDULER_ENABLED: value }, logger: { log() {}, error() {} } });
      assert.equal(task, null);
      assert.equal(cron.jobs.length, 0);
    }
  });

  test('an overlapping run is skipped, and a failing sync does not crash the job', async () => {
    const cron = fakeCron();
    let release;
    let calls = 0;
    const errors = [];
    startSyncScheduler({
      cronLib: cron,
      sync: () => { calls++; return new Promise((r) => { release = r; }); },
      env: {},
      logger: { log() {}, error: (...a) => errors.push(a) }
    });
    const first = cron.jobs[0].fn();
    await cron.jobs[0].fn(); // second tick while first is running -> skipped
    assert.equal(calls, 1);
    release();
    await first;

    const cron2 = fakeCron();
    startSyncScheduler({ cronLib: cron2, sync: async () => { throw new Error('boom'); }, env: {}, logger: { log() {}, error: (...a) => errors.push(a) } });
    await cron2.jobs[0].fn();
    assert.equal(errors.length, 1);
  });

  test('source: only scheduler.js schedules; sync.js and server.js do not', () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/node-cron|cron\.schedule/.test(read('sync.js')), 'sync.js must not schedule or import node-cron');
    assert.ok(!/node-cron|cron\.schedule/.test(read('server.js')), 'server.js must not schedule directly');
    assert.equal((read('scheduler.js').match(/cron\.schedule\(/g) || []).length, 1);
    const server = read('server.js');
    assert.equal((server.match(/startSyncScheduler\(/g) || []).length, 1, 'scheduler started once');
    assert.ok(!/syncCommits/.test(server), 'no sync call on startup');
  });
});

// ---- input validation -------------------------------------------------------------------
describe('manual write validation', () => {
  async function expectRejected(url, body, label) {
    const res = await post(url, body, bearer());
    assert.equal(res.status, 400, label);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.ok(Array.isArray(json.details) && json.details.length > 0, label);
    assert.equal(fakeDb.writes().length, 0, `${label}: must not write`);
  }

  test('sleep: rejects bad dates', async () => {
    for (const date of [undefined, null, '', 'abc', '10/02/2026', '2026-13-01', '2026-02-30', '2026-9-1', 20260920, '1999-12-31', '2999-01-01']) {
      await expectRejected('/api/me/sleep', { ...goodSleep, date }, `date=${String(date)}`);
    }
  });

  test('sleep: rejects bad hours and quality', async () => {
    for (const hours_slept of [undefined, null, -1, 24.5, 100, '8', 'eight', NaN, Infinity]) {
      await expectRejected('/api/me/sleep', { ...goodSleep, hours_slept }, `hours=${String(hours_slept)}`);
    }
    for (const quality of [undefined, null, -0.1, 1.1, 5, '0.5']) {
      await expectRejected('/api/me/sleep', { ...goodSleep, quality }, `quality=${String(quality)}`);
    }
  });

  test('sleep: rejects bad source', async () => {
    for (const source of [123, '', '   ', 'x'.repeat(51), "x'; DROP TABLE sleep;--", '<script>']) {
      await expectRejected('/api/me/sleep', { ...goodSleep, source }, `source=${String(source).slice(0, 15)}`);
    }
  });

  test('sleep: accepts valid edge values (0 hours, 24 hours, quality 0 and 1) and defaults source', async () => {
    for (const body of [
      { date: '2026-09-20', hours_slept: 0, quality: 0 },
      { date: '2026-09-20', hours_slept: 24, quality: 1 }
    ]) {
      fakeDb.reset();
      const res = await post('/api/me/sleep', body, bearer());
      assert.equal(res.status, 200);
      assert.equal(fakeDb.writes().length, 1);
      assert.equal(fakeDb.writes()[0].params[3], 'manual');
    }
  });

  test('sleep: only known fields reach the database', async () => {
    const res = await post('/api/me/sleep', { ...goodSleep, id: 99, is_admin: true, extra: 'x' }, bearer());
    assert.equal(res.status, 200);
    assert.deepEqual(fakeDb.writes()[0].params, ['2026-09-20', 7.5, 0.5, 'manual']);
  });

  test('screen time: rejects bad values', async () => {
    const bad = [
      { total_minutes: undefined },
      { total_minutes: -5 },
      { total_minutes: 1441 },
      { total_minutes: 120.5 },
      { total_minutes: '300' },
      { total_minutes: NaN },
      { work_minutes: -1 },
      { work_minutes: 1.5 },
      { entertainment_minutes: 'lots' },
      { social_minutes: 99999 },
      { date: 'nope' },
      { date: '2999-01-01' },
      { work_minutes: 250, entertainment_minutes: 100 } // 350 > total 300
    ];
    for (const patch of bad) {
      await expectRejected('/api/me/screen-time', { ...goodScreen, ...patch }, JSON.stringify(patch));
    }
  });

  test('screen time: accepts zero and fills missing optional fields with 0', async () => {
    const res = await post('/api/me/screen-time', { date: '2026-09-20', total_minutes: 0 }, bearer());
    assert.equal(res.status, 200);
    assert.deepEqual(fakeDb.writes()[0].params, ['2026-09-20', 0, 0, 0, 0, 'manual']);
  });

  test('body must be a JSON object (arrays, strings, missing bodies, bad JSON)', async () => {
    for (const body of ['[]', '"text"', 'null', '{not json', '']) {
      const res = await post('/api/me/sleep', body, bearer());
      assert.equal(res.status, 400, `body ${JSON.stringify(body)}`);
      const text = await res.text();
      assert.ok(!/SyntaxError|at JSON\.parse|node_modules/.test(text), 'no stack trace in response');
    }
    const noBody = await fetch(base + '/api/me/sleep', { method: 'POST', headers: bearer() });
    assert.equal(noBody.status, 400);
    assert.equal(fakeDb.writes().length, 0);
  });

  test('oversized bodies are rejected with 413', async () => {
    const res = await post('/api/me/sleep', { ...goodSleep, source: 'x'.repeat(50_000) }, bearer());
    assert.equal(res.status, 413);
    assert.equal(fakeDb.writes().length, 0);
  });

  test('validators are pure and use Nepal date for "today"', () => {
    // 2026-10-03 20:00 UTC is already 2026-10-04 in Nepal (UTC+5:45)
    const now = new Date('2026-10-03T20:00:00Z');
    assert.equal(validateSleepInput({ ...goodSleep, date: '2026-10-04' }, now).ok, true);
    assert.equal(validateSleepInput({ ...goodSleep, date: '2026-10-05' }, now).ok, false);
    assert.equal(validateScreenTimeInput({ ...goodScreen, date: '2026-10-04' }, now).ok, true);
  });
});

// ---- database errors are not leaked ----------------------------------------------------------
describe('database errors stay on the server', () => {
  const leaky = 'duplicate key value violates constraint "sleep_pkey" at db.internal.railway postgres://user:pw@host';

  test('sleep and screen-time return a generic 500', async () => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      fakeDb.handler = () => { throw new Error(leaky); };
      for (const [url, body] of [['/api/me/sleep', goodSleep], ['/api/me/screen-time', goodScreen]]) {
        const res = await post(url, body, bearer());
        assert.equal(res.status, 500);
        const text = await res.text();
        assert.ok(!/constraint|railway|postgres|pw@host/.test(text), `leaked: ${text}`);
        assert.match(text, /Failed to save/);
      }
    } finally {
      console.error = original;
    }
    assert.ok(logged.some((l) => l.includes('constraint')), 'real error is still logged server-side');
  });

  test('read routes also return generic errors', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      fakeDb.handler = () => { throw new Error(leaky); };
      for (const url of ['/api/me/commits', '/api/me/sleep', '/api/me/screen-time', '/api/me/today']) {
        const res = await fetch(base + url);
        const text = await res.text();
        assert.ok(!/constraint|railway|postgres|pw@host/.test(text), `${url} leaked: ${text}`);
      }
    } finally {
      console.error = original;
    }
  });
});

// ---- CORS ---------------------------------------------------------------------------------------
describe('CORS allow-list', () => {
  const DASHBOARD = DEFAULT_ORIGINS[0];

  async function withCors(envValue, fn) {
    await new Promise((resolve) => server.close(resolve));
    setEnv({ CORS_ORIGINS: envValue });
    await startServer();
    await fn();
  }

  test('default: only the Railway dashboard origin is allowed', async () => {
    const ok = await fetch(base + '/api/me/commits', { headers: { Origin: DASHBOARD } });
    assert.equal(ok.headers.get('access-control-allow-origin'), DASHBOARD);
    const bad = await fetch(base + '/api/me/commits', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    assert.notEqual(ok.headers.get('access-control-allow-origin'), '*');
  });

  test('preflight for the dashboard allows Authorization + POST; others get no CORS headers', async () => {
    const pre = await fetch(base + '/api/me/sleep', {
      method: 'OPTIONS',
      headers: { Origin: DASHBOARD, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), DASHBOARD);
    assert.match(pre.headers.get('access-control-allow-headers') || '', /Authorization/i);
    assert.match(pre.headers.get('access-control-allow-methods') || '', /POST/);
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);

    const evil = await fetch(base + '/api/me/sleep', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });

  test('CORS_ORIGINS env var controls the list; "*" is refused', async () => {
    await withCors('http://localhost:3000/, https://dash.example.com, *', async () => {
      for (const origin of ['http://localhost:3000', 'https://dash.example.com']) {
        const res = await fetch(base + '/health', { headers: { Origin: origin } });
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
      }
      const dflt = await fetch(base + '/health', { headers: { Origin: DASHBOARD } });
      assert.equal(dflt.headers.get('access-control-allow-origin'), null, 'default is replaced when env is set');
      const star = await fetch(base + '/health', { headers: { Origin: 'https://anything.example' } });
      assert.equal(star.headers.get('access-control-allow-origin'), null);
    });
  });

  test('CORS does not replace auth: an allowed origin still needs the token to write', async () => {
    const res = await post('/api/me/sleep', goodSleep, { Origin: DASHBOARD });
    assert.equal(res.status, 401);
  });

  test('parseCorsOrigins normalises and drops invalid entries', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(parseCorsOrigins(undefined), DEFAULT_ORIGINS);
      assert.deepEqual(parseCorsOrigins(''), DEFAULT_ORIGINS);
      assert.deepEqual(parseCorsOrigins('*'), []);
      assert.deepEqual(parseCorsOrigins('https://A.example.com/ ,not a url, ftp://x.com, https://x.com/path'), ['https://a.example.com']);
    } finally {
      console.warn = warn;
    }
  });
});

// ---- dashboard keeps the token out of public code ----------------------------------------------------
describe('dashboard frontend', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  test('contains no token value or token variable name', () => {
    assert.ok(!html.includes('ADMIN_API_TOKEN'));
    assert.ok(!html.includes(TEST_TOKEN));
    assert.ok(!/Bearer\s+[A-Za-z0-9]{16,}/.test(html), 'no hard-coded bearer token');
  });

  test('Authorization header is set in exactly one place (the save helper), never on GETs', () => {
    assert.equal((html.match(/Authorization/g) || []).length, 1);
    const getFetches = html.match(/fetch\(`\$\{API_URL\}\/api\/me[^`]*`\)/g) || [];
    assert.ok(getFetches.length >= 2, 'dashboard still loads data with plain GETs');
  });

  test('token is kept in sessionStorage only, and cleared when the server rejects it', () => {
    assert.ok(html.includes('sessionStorage.setItem(ADMIN_TOKEN_KEY'));
    // (the dashboard legitimately uses localStorage for the theme toggle; the token must never go there)
    assert.ok(!/localStorage[^\n]*(token|TOKEN)/.test(html), 'token must not be put in localStorage');
    assert.ok(!/ADMIN_TOKEN_KEY[^\n]*localStorage|localStorage[^\n]*ADMIN_TOKEN_KEY/.test(html));
    assert.match(html, /response\.status === 401 \|\| response\.status === 403\) \{\s*clearAdminToken\(\)/);
  });

  test('both forms save through the token helper', () => {
    assert.ok(html.includes("postWithAdminToken('/api/me/sleep'"));
    assert.ok(html.includes("postWithAdminToken('/api/me/screen-time'"));
    assert.ok(!/method:\s*'POST'[\s\S]{0,80}\n\s*headers: \{ 'Content-Type': 'application\/json' \}/.test(html), 'no unauthenticated POST left');
  });
});
