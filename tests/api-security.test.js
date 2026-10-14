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
const { createSyncRunner, describeError } = require('../sync-runner');
const { parseCorsOrigins, DEFAULT_ORIGINS } = require('../middleware/cors');
const { validateSleepInput, validateScreenTimeInput } = require('../lib/validation');

// ---- fake sync runner (so no test can ever start a real GitHub sync) --------------
const fakeRunner = {
  calls: [],
  result: null,
  reset() {
    this.calls = [];
    this.result = { status: 'done', summary: { repos: 2, fetched: 5, inserted: 3, alreadySaved: 2, failed: 0 }, durationMs: 12 };
  },
  async run(trigger) {
    this.calls.push(trigger);
    return this.result;
  }
};

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
  const app = createApp({ syncRunner: fakeRunner });
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
  fakeRunner.reset();
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

// ---- sync: no public trigger; the button is admin-only --------------------------------
describe('public sync endpoint removed', () => {
  test('GET /api/sync is gone (404) and triggers nothing', async () => {
    const res = await fetch(base + '/api/sync');
    assert.equal(res.status, 404);
    assert.equal(fakeDb.calls.length, 0);
    assert.equal(fakeRunner.calls.length, 0);
  });

  test('POST /api/sync needs the token, and still does not exist with it', async () => {
    assert.equal((await post('/api/sync', {})).status, 401);
    assert.equal((await post('/api/sync', {}, bearer())).status, 404);
    assert.equal(fakeRunner.calls.length, 0);
  });

  test('no GET route can start a sync (including /api/me/sync)', async () => {
    for (const url of ['/api/me/sync', '/api/sync', '/api/me/sync/run']) {
      assert.equal((await fetch(base + url)).status, 404, `GET ${url}`);
    }
    assert.equal(fakeRunner.calls.length, 0);
  });

  test('source: no GET route is defined for sync', () => {
    for (const file of ['app.js', 'server.js', ...fs.readdirSync(path.join(ROOT, 'routes')).map((f) => `routes/${f}`)]) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/\.get\(\s*['"`][^'"`]*sync/i.test(src), `${file} must not define a GET sync route`);
      assert.ok(!/['"`]\/api\/sync['"`]/.test(src), `${file} must not define /api/sync`);
    }
  });
});

describe('"Sync now" endpoint: POST /api/me/sync (admin token required)', () => {
  test('missing token -> 401 and no sync started', async () => {
    const res = await post('/api/me/sync', {});
    assert.equal(res.status, 401);
    assert.equal(fakeRunner.calls.length, 0);
  });

  test('wrong token / malformed credentials -> 401 and no sync started', async () => {
    for (const headers of [bearer(OTHER_TOKEN), bearer('short'), { Authorization: `Basic ${TEST_TOKEN}` }, { Authorization: TEST_TOKEN }]) {
      assert.equal((await post('/api/me/sync', {}, headers)).status, 401);
    }
    assert.equal((await post(`/api/me/sync?token=${TEST_TOKEN}`, { token: TEST_TOKEN })).status, 401);
    assert.equal(fakeRunner.calls.length, 0);
  });

  test('ADMIN_API_TOKEN missing or too short -> fail closed (503), no sync started', async () => {
    setEnv({ ADMIN_API_TOKEN: undefined });
    assert.equal((await post('/api/me/sync', {}, bearer())).status, 503);
    setEnv({ ADMIN_API_TOKEN: 'short-secret' });
    assert.equal((await post('/api/me/sync', {}, bearer('short-secret'))).status, 503);
    assert.equal(fakeRunner.calls.length, 0);
  });

  test('other methods need the token too, and have no handler even with it', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(base + '/api/me/sync', { method })).status, 401);
      assert.equal((await fetch(base + '/api/me/sync', { method, headers: bearer() })).status, 404);
    }
    assert.equal(fakeRunner.calls.length, 0);
  });

  test('valid token -> starts exactly one manual sync and returns only counts', async () => {
    const res = await post('/api/me/sync', {}, bearer());
    assert.equal(res.status, 200);
    assert.deepEqual(fakeRunner.calls, ['manual']);
    const json = await res.json();
    assert.deepEqual(json, {
      success: true,
      data: { repos: 2, fetched: 5, inserted: 3, already_saved: 2, failed: 0, duration_ms: 12 }
    });
  });

  test('a sync that is already running -> 409', async () => {
    fakeRunner.result = { status: 'busy' };
    const res = await post('/api/me/sync', {}, bearer());
    assert.equal(res.status, 409);
    assert.equal((await res.json()).success, false);
  });

  test('cooldown -> 429 with Retry-After', async () => {
    fakeRunner.result = { status: 'cooldown', retryAfterSeconds: 42 };
    const res = await post('/api/me/sync', {}, bearer());
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '42');
    const json = await res.json();
    assert.equal(json.retry_after_seconds, 42);
    assert.match(json.error, /42 seconds/);
  });

  test('a failed sync -> generic 502 with no internal details', async () => {
    fakeRunner.result = { status: 'failed' };
    const res = await post('/api/me/sync', {}, bearer());
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.match(text, /Sync failed/);
    assert.ok(!/ECONN|password|github\.com|token/i.test(text));
  });

  test('a crash inside the runner is hidden behind a generic 500', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      fakeRunner.run = async () => { throw new Error('secret internal detail postgres://u:p@h'); };
      const res = await post('/api/me/sync', {}, bearer());
      assert.equal(res.status, 500);
      assert.ok(!/secret internal|postgres/.test(await res.text()));
    } finally {
      console.error = original;
      delete fakeRunner.run; // back to the prototype method
    }
  });
});

describe('sync runner (one sync at a time, manual cooldown)', () => {
  const quiet = { log() {}, error() {} };
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  test('runs the sync and returns its summary', async () => {
    const c = clock();
    const runner = createSyncRunner({ sync: async () => ({ inserted: 4 }), logger: quiet, now: c.now });
    const result = await runner.run('manual');
    assert.equal(result.status, 'done');
    assert.deepEqual(result.summary, { inserted: 4 });
  });

  test('manual syncs have a 60-second cooldown; it expires', async () => {
    const c = clock();
    let calls = 0;
    const runner = createSyncRunner({ sync: async () => { calls++; return {}; }, logger: quiet, now: c.now });
    assert.equal((await runner.run('manual')).status, 'done');
    c.advance(10_000);
    const second = await runner.run('manual');
    assert.equal(second.status, 'cooldown');
    assert.equal(second.retryAfterSeconds, 50);
    assert.equal(calls, 1, 'cooldown must not start another sync');
    c.advance(50_000);
    assert.equal((await runner.run('manual')).status, 'done');
    assert.equal(calls, 2);
  });

  test('the hourly (scheduled) run ignores the cooldown', async () => {
    const c = clock();
    let calls = 0;
    const runner = createSyncRunner({ sync: async () => { calls++; return {}; }, logger: quiet, now: c.now });
    await runner.run('manual');
    assert.equal((await runner.run('scheduled')).status, 'done');
    assert.equal(calls, 2);
  });

  test('never two at once: a manual and a scheduled run see "busy" while one is running', async () => {
    const c = clock();
    let release;
    let calls = 0;
    const runner = createSyncRunner({
      sync: () => { calls++; return new Promise((r) => { release = () => r({}); }); },
      logger: quiet,
      now: c.now
    });
    const first = runner.run('scheduled');
    assert.equal(runner.isRunning(), true);
    assert.equal((await runner.run('manual')).status, 'busy');
    assert.equal((await runner.run('scheduled')).status, 'busy');
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 'done');
    assert.equal(runner.isRunning(), false);
  });

  test('a failing sync is reported as failed, logged with a real reason, and unlocks the runner', async () => {
    const c = clock();
    const errors = [];
    let fail = true;
    const runner = createSyncRunner({
      sync: async () => {
        if (fail) { const e = new Error(''); e.errors = [{ code: 'ECONNREFUSED' }]; throw e; }
        return {};
      },
      logger: { log() {}, error: (...a) => errors.push(a.join(' ')) },
      now: c.now
    });
    assert.deepEqual(await runner.run('scheduled'), { status: 'failed' });
    assert.equal(runner.isRunning(), false);
    assert.ok(errors[0].includes('ECONNREFUSED'), `logged: ${errors[0]}`);
    fail = false;
    assert.equal((await runner.run('scheduled')).status, 'done');
  });

  test('describeError never returns an empty string', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
    assert.equal(describeError(Object.assign(new Error(''), { code: 'ENOTFOUND' })), 'ENOTFOUND');
    assert.equal(describeError(Object.assign(new Error(''), { errors: [{ code: 'ECONNREFUSED' }] })), 'ECONNREFUSED');
    assert.equal(describeError(null), 'unknown error');
    assert.equal(describeError(new Error('')), 'unknown error');
  });
});

describe('sync job (sync.js) reports honest results', () => {
  // sync.js is loaded here with a fake GitHub (axios) and the fake database, so nothing
  // touches the network, a real database, or your .env.
  const axiosPath = require.resolve('axios');
  const dotenvPath = require.resolve('dotenv');
  const syncPath = require.resolve('../sync');

  function loadSync({ axiosGet }) {
    require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { get: axiosGet } };
    require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config() {} } };
    delete require.cache[syncPath];
    return require('../sync').syncCommits;
  }

  function githubFake(reposFail = false) {
    const commit = (sha) => ({ sha, commit: { message: `msg ${sha}`, author: { name: 'Me', date: '2026-09-01T10:00:00Z' } } });
    return async (url) => {
      if (url.endsWith('/repos')) {
        if (reposFail) throw new Error('Request failed with status code 401');
        return { data: [{ name: 'a' }, { name: 'b' }] };
      }
      if (url.includes('/repos/kissmoon17/a/')) return { data: [commit('s1'), commit('s2')] };
      if (url.includes('/repos/kissmoon17/b/')) return { data: [commit('s3')] };
      throw new Error('unexpected url ' + url);
    };
  }

  async function quietly(fn) {
    const log = console.log;
    const err = console.error;
    const lines = { log: [], error: [] };
    console.log = (...a) => lines.log.push(a.join(' '));
    console.error = (...a) => lines.error.push(a.join(' '));
    try {
      return { value: await fn(), lines };
    } finally {
      console.log = log;
      console.error = err;
    }
  }

  test('counts new vs already-saved commits', async () => {
    const seen = new Set(['s2']); // s2 is already in the database
    fakeDb.handler = (sql, params) => {
      const isNew = !seen.has(params[0]);
      seen.add(params[0]);
      return { rows: [], rowCount: isNew ? 1 : 0 };
    };
    const syncCommits = loadSync({ axiosGet: githubFake() });
    const { value } = await quietly(() => syncCommits());
    assert.deepEqual(value, { repos: 2, fetched: 3, inserted: 2, alreadySaved: 1, failed: 0 });
  });

  test('database failure: counted as failed, real reason logged ONCE (not blank, not per commit)', async () => {
    fakeDb.handler = () => {
      const e = new Error('');
      e.errors = [{ code: 'ECONNREFUSED' }];
      throw e;
    };
    const syncCommits = loadSync({ axiosGet: githubFake() });
    const { value, lines } = await quietly(() => syncCommits());
    assert.equal(value.failed, 3);
    assert.equal(value.inserted, 0);
    const insertErrors = lines.error.filter((l) => l.startsWith('Error inserting commit'));
    assert.equal(insertErrors.length, 1);
    assert.match(insertErrors[0], /ECONNREFUSED/);
    assert.ok(lines.log.some((l) => /3 failed to save/.test(l)) && !lines.log.some((l) => /Sync complete/.test(l)));
  });

  test("GitHub repo list failure: the sync rejects (so the button/schedule can report it)", async () => {
    const syncCommits = loadSync({ axiosGet: githubFake(true) });
    await assert.rejects(quietly(() => syncCommits()), /401/);
  });
});

// ---- exactly one scheduler ---------------------------------------------------------
describe('commit sync scheduling', () => {
  function fakeCron() {
    const jobs = [];
    return { jobs, schedule(expr, fn) { jobs.push({ expr, fn }); return { stop() {} }; } };
  }
  const quiet = { log() {}, error() {} };

  test('registers exactly one hourly job and does NOT sync on startup', async () => {
    const cron = fakeCron();
    const runner = { calls: [], async run(trigger) { this.calls.push(trigger); return { status: 'done' }; } };
    startSyncScheduler({ cronLib: cron, runner, env: {}, logger: quiet });
    assert.equal(cron.jobs.length, 1);
    assert.equal(cron.jobs[0].expr, SYNC_SCHEDULE);
    assert.equal(SYNC_SCHEDULE, '0 * * * *');
    assert.equal(runner.calls.length, 0, 'no sync at startup');
    await cron.jobs[0].fn();
    assert.deepEqual(runner.calls, ['scheduled']);
  });

  test('SYNC_SCHEDULER_ENABLED=false registers nothing', () => {
    for (const value of ['false', 'FALSE', '0', 'off']) {
      const cron = fakeCron();
      const task = startSyncScheduler({ cronLib: cron, runner: { run: async () => ({}) }, env: { SYNC_SCHEDULER_ENABLED: value }, logger: quiet });
      assert.equal(task, null);
      assert.equal(cron.jobs.length, 0);
    }
  });

  test('a busy runner just skips the hourly tick', async () => {
    const cron = fakeCron();
    const logs = [];
    startSyncScheduler({ cronLib: cron, runner: { run: async () => ({ status: 'busy' }) }, env: {}, logger: { log: (m) => logs.push(m), error() {} } });
    await cron.jobs[0].fn();
    assert.ok(logs.some((m) => /skipping/.test(m)));
  });

  test('source: only scheduler.js schedules; sync.js and server.js do not; nothing syncs at startup', () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/node-cron|cron\.schedule/.test(read('sync.js')), 'sync.js must not schedule or import node-cron');
    assert.ok(!/node-cron|cron\.schedule/.test(read('server.js')), 'server.js must not schedule directly');
    assert.ok(!/node-cron|cron\.schedule/.test(read('sync-runner.js')));
    assert.equal((read('scheduler.js').match(/cron\.schedule\(/g) || []).length, 1);
    const server = read('server.js');
    assert.equal((server.match(/startSyncScheduler\(/g) || []).length, 1, 'scheduler started once');
    assert.ok(!/\.run\(|syncCommits\(/.test(server), 'server.js must not start a sync at startup');
    assert.equal((server.match(/createSyncRunner\(/g) || []).length, 1, 'one shared runner');
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

  test('the Sync button uses the same token helper and has no other way to call the server', () => {
    assert.ok(html.includes('id="syncBtn"') && html.includes('onclick="syncNow()"'));
    assert.ok(html.includes("postWithAdminToken('/api/me/sync'"));
    assert.ok(!/fetch\([^)]*\/api\/(me\/)?sync/.test(html), 'must not call the sync URL with a bare fetch');
  });

  test('both forms save through the token helper', () => {
    assert.ok(html.includes("postWithAdminToken('/api/me/sleep'"));
    assert.ok(html.includes("postWithAdminToken('/api/me/screen-time'"));
    assert.ok(!/method:\s*'POST'[\s\S]{0,80}\n\s*headers: \{ 'Content-Type': 'application\/json' \}/.test(html), 'no unauthenticated POST left');
  });
});
