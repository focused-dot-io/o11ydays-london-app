'use strict';

// Integration harness for the Roast Judge app (not a test file: no `.test.js` suffix, so the
// `test/**/*.test.js` glob skips it). One harness per test file: start() in `before`, stop() in `after`.
//
// It runs THREE child processes, each on a free port picked here (a throwaway net server on port 0):
//   pub-guide : node services/pub-guide/server.js            env PORT=<pub>
//               (no --require: it is not instrumented, so its spans never mix into the app's)
//   replay    : node services/model-replay/server.js         env PORT=<replay> REPLAY_LATENCY_SCALE=0
//                                                                REPLAY_FAIL_EVERY=0
//   app       : node --require ./src/telemetry.js --disable-warning=ExperimentalWarning
//                    test/helpers/app-child.js
//               env ROASTJUDGE_EXPORTER=memory PORT=<app> SEAT=0
//                   REPLAY_URL=http://127.0.0.1:<replay>/v1
//                   PUB_GUIDE_URL=http://127.0.0.1:<pub>
//
// Children inherit only PATH and HOME (no OTEL_*, ROASTJUDGE_MODEL or OPENAI_API_KEY leak in).
//
// ENV CONTRACT the implementer must follow (ASSUMPTIONS beyond SPEC.md):
//   - src/server.js reads the pub-guide base URL from PUB_GUIDE_URL (default http://localhost:4100,
//     no trailing slash) at request time or createApp() time (it is set before the process starts),
//     and passes it to the agent as pubGuideUrl.
//   - src/server.js reads the replay URL only through src/model-client.js (REPLAY_URL).
//   - The test-only routes GET /__spans and POST /__spans/reset live in test/helpers/app-child.js,
//     NOT in src/. src/server.js must not claim /__spans.
//   - createApp() returns an express app usable as a plain (req, res) handler.

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startChild(label, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { label, child, out: '', exited: null };
  child.stdout.on('data', (d) => {
    state.out += d;
  });
  child.stderr.on('data', (d) => {
    state.out += d;
  });
  child.on('exit', (code, signal) => {
    state.exited = { code, signal };
  });
  return state;
}

function describe(state) {
  const tail = state.out.length > 4000 ? `...${state.out.slice(-4000)}` : state.out;
  return `[${state.label}] exited=${JSON.stringify(state.exited)}\n${tail}`;
}

async function waitHealthy(state, url, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`${state.label} exited before becoming healthy\n${describe(state)}`);
    try {
      const res = await fetch(url);
      if (res.ok) {
        await res.arrayBuffer();
        return;
      }
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`${state.label} not healthy at ${url}: ${lastErr && lastErr.message}\n${describe(state)}`);
}

async function stopChild(state) {
  if (!state || state.exited) return;
  const done = new Promise((resolve) => state.child.once('exit', resolve));
  state.child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (!state.exited) state.child.kill('SIGKILL');
  }, 3000);
  await done;
  clearTimeout(timer);
}

function queryString(query) {
  if (!query) return '';
  if (typeof query === 'string') return query.startsWith('?') ? query : `?${query}`;
  const qs = new URLSearchParams(query).toString();
  return qs ? `?${qs}` : '';
}

async function createHarness() {
  const [pubPort, replayPort, appPort] = [await freePort(), await freePort(), await freePort()];
  const h = {
    pubUrl: `http://127.0.0.1:${pubPort}`,
    replayUrl: `http://127.0.0.1:${replayPort}/v1`,
    appUrl: `http://127.0.0.1:${appPort}`,
    children: [],
  };

  const pub = startChild('pub-guide', ['services/pub-guide/server.js'], { PORT: String(pubPort) });
  const replay = startChild('model-replay', ['--disable-warning=ExperimentalWarning', 'services/model-replay/server.js'], {
    PORT: String(replayPort),
    REPLAY_LATENCY_SCALE: '0',
    REPLAY_FAIL_EVERY: '0',
  });
  h.children.push(pub, replay);

  h.stop = async () => {
    await Promise.all(h.children.map(stopChild));
  };

  try {
    await Promise.all([waitHealthy(pub, `${h.pubUrl}/healthz`), waitHealthy(replay, `http://127.0.0.1:${replayPort}/healthz`)]);
    const app = startChild(
      'roast-judge',
      ['--require', './src/telemetry.js', '--disable-warning=ExperimentalWarning', 'test/helpers/app-child.js'],
      {
        ROASTJUDGE_EXPORTER: 'memory',
        PORT: String(appPort),
        SEAT: '0',
        REPLAY_URL: h.replayUrl,
        PUB_GUIDE_URL: h.pubUrl,
      },
    );
    h.children.push(app);
    h.app = app;
    await waitHealthy(app, `${h.appUrl}/healthz`);
  } catch (err) {
    await h.stop();
    throw err;
  }

  /** Raw request against the app. Returns { status, headers (plain object), body (parsed JSON or text) }. */
  h.request = async (method, urlPath, { body, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(`${h.appUrl}${urlPath}`, init);
    const raw = await res.text();
    let parsed = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // leave as text
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed };
  };

  h.judge = (text, { query, headers } = {}) =>
    h.request('POST', `/judge${queryString(query)}`, { body: text === undefined ? {} : { text }, headers });
  h.appeal = (id, text, { query, headers } = {}) =>
    h.request('POST', `/judge/${encodeURIComponent(id)}/appeal${queryString(query)}`, { body: { text }, headers });
  h.final = (id, { query, headers } = {}) =>
    h.request('POST', `/judge/${encodeURIComponent(id)}/final${queryString(query)}`, { body: {}, headers });
  h.getPrompt = () => h.request('GET', '/admin/prompt');
  h.setPrompt = (version) => h.request('POST', '/admin/prompt', { body: { version } });

  /** All finished spans in the app's in-memory exporter (serialised by app-child.js). */
  h.spans = async () => {
    const res = await fetch(`${h.appUrl}/__spans`);
    const body = await res.json();
    if (!res.ok) throw new Error(`/__spans failed: ${JSON.stringify(body)}`);
    return body;
  };
  h.resetSpans = async () => {
    const res = await fetch(`${h.appUrl}/__spans/reset`, { method: 'POST' });
    await res.arrayBuffer();
  };

  /**
   * Spans of one trace. Polls until the trace's root HTTP SERVER span (kind 1, no parent) has
   * finished, because the SERVER span ends just after the response is written.
   */
  h.traceSpans = async (traceId, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    let spans = [];
    while (Date.now() < deadline) {
      spans = (await h.spans()).filter((s) => s.traceId === traceId);
      if (spans.some((s) => s.kind === 1 && !s.parentSpanId)) {
        await sleep(30);
        return (await h.spans()).filter((s) => s.traceId === traceId);
      }
      await sleep(50);
    }
    return spans;
  };

  h.logs = () => h.children.map(describe).join('\n');
  return h;
}

module.exports = { createHarness, freePort, ROOT };
