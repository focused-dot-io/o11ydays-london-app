'use strict';

// Phase 2: services/model-replay/server.js (HTTP wrapper over the Phase 1 engine).
// ASSUMPTION: createApp({ env } = {}) where env defaults to process.env and is passed to
// the engine as options.env (REPLAY_LATENCY_SCALE / REPLAY_FAIL_EVERY are read from it).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'replay', 'corpus.json'), 'utf8'));
const PROMPT_V1 = fs.readFileSync(path.join(ROOT, 'prompts', 'roast-judge.v1.md'), 'utf8');
const REPLAY_MODEL = 'gpt-4.1-mini-2025-04-14';
const QUIET_ENV = { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' };

function listen(app) {
  return new Promise((resolve, reject) => {
    const target = typeof app.listen === 'function' ? app : http.createServer(app);
    const srv = target.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({ server: srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
    srv.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function start(env = QUIET_ENV) {
  const { createApp } = require('../services/model-replay/server.js');
  const { server, base } = await listen(createApp({ env }));
  servers.push(server);
  return base;
}

function v1Step1Body(text = corpus[0].text) {
  return {
    model: 'gpt-4.1-mini',
    input: [
      { role: 'developer', content: PROMPT_V1 },
      { role: 'user', content: text },
    ],
    tools: [],
  };
}

function post(base, body, headers = {}) {
  return fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('replay server: exports createApp()', () => {
  const mod = require('../services/model-replay/server.js');
  assert.equal(typeof mod.createApp, 'function');
  assert.ok(mod.createApp({ env: QUIET_ENV }));
  assert.ok(mod.createApp(), 'createApp() with no arguments also works');
});

test('replay server: GET /healthz -> 200', async () => {
  const base = await start();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
});

test('replay server: POST /v1/responses v1 step 1 -> 200 Responses object with function_call items', async () => {
  const base = await start();
  const body = v1Step1Body();
  const res = await post(base, body);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const json = await res.json();
  assert.equal(json.object, 'response');
  assert.equal(json.model, REPLAY_MODEL);
  assert.equal(json.status, 'completed');
  assert.match(json.id, /^resp_/);
  assert.ok(Array.isArray(json.output));
  const calls = json.output.filter((i) => i.type === 'function_call');
  assert.ok(calls.length > 0, 'has function_call items');
  const names = new Set(calls.map((c) => c.name));
  for (const n of ['score_component', 'lookup_pub', 'compare_to_benchmarks']) assert.ok(names.has(n), `calls ${n}`);
  for (const c of calls) {
    assert.match(c.call_id, /^call_/);
    assert.equal(typeof c.arguments, 'string');
    JSON.parse(c.arguments);
  }
  assert.equal(typeof json.usage.input_tokens, 'number');
  assert.equal(typeof json.usage.output_tokens, 'number');

  // The server is a thin wrapper: its output matches the engine's for the same body.
  const { respond } = require('../services/model-replay/engine.js');
  const direct = respond(body, {}, { env: QUIET_ENV, callCounter: { n: 0 } });
  assert.deepEqual(json.output, direct.body.output);
});

test('replay server: x-replay-fail: 1 -> 500 OpenAI-shaped server_error', async () => {
  const base = await start();
  const res = await post(base, v1Step1Body(), { 'x-replay-fail': '1' });
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const json = await res.json();
  assert.ok(json.error, 'error body');
  assert.equal(json.error.type, 'server_error');
  assert.equal(typeof json.error.message, 'string');
});

test('replay server: REPLAY_LATENCY_SCALE=0 answers in < 200 ms', async () => {
  const base = await start({ REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' });
  // warm-up request (connection setup), then time one
  await (await post(base, v1Step1Body())).arrayBuffer();
  const t0 = performance.now();
  const res = await post(base, v1Step1Body(corpus[1].text));
  await res.json();
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(ms < 200, `took ${ms.toFixed(1)} ms`);
});

test('replay server: honours engine latency when REPLAY_LATENCY_SCALE=1', async () => {
  const base = await start({ REPLAY_LATENCY_SCALE: '1', REPLAY_FAIL_EVERY: '0' });
  const body = v1Step1Body(corpus[2].text);
  const { respond } = require('../services/model-replay/engine.js');
  const expected = respond(body, {}, { env: { REPLAY_LATENCY_SCALE: '1', REPLAY_FAIL_EVERY: '0' }, callCounter: { n: 0 } }).latencyMs;
  assert.ok(expected >= 300, 'engine latency at scale 1 is at least the 300 ms base');
  const t0 = performance.now();
  const res = await post(base, body);
  await res.json();
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(ms >= expected - 25, `took ${ms.toFixed(1)} ms, engine latency ${expected} ms`);
});

test('replay server: REPLAY_FAIL_EVERY from env is honoured (every 2nd call fails)', async () => {
  const base = await start({ REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '2' });
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const res = await post(base, v1Step1Body());
    await res.arrayBuffer();
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [200, 500, 200, 500]);
});

test('replay server: non-JSON body -> 400 with JSON error body', async () => {
  const base = await start();
  const res = await post(base, 'this is { not json');
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const json = await res.json();
  assert.ok(json.error, 'error body');
});
