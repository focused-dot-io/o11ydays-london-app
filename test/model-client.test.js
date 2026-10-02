'use strict';

// Phase 2: src/model-client.js
// ASSUMPTION: model-client reads process.env when replayUrl()/isReplayRequest()/getClient()
// are called (no env captured at require time is relied on; tests also re-require fresh).

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { OpenAI } = require('openai');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'model-client.js');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'replay', 'corpus.json'), 'utf8'));
const PROMPT_V1 = fs.readFileSync(path.join(ROOT, 'prompts', 'roast-judge.v1.md'), 'utf8');
const DEFAULT_REPLAY_URL = 'http://localhost:4200/v1';
const ENV_KEYS = ['REPLAY_URL', 'ROASTJUDGE_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'REPLAY_LATENCY_SCALE', 'REPLAY_FAIL_EVERY'];

function fresh() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

let saved;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

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
const servers = [];
after(async () => {
  for (const s of servers) {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    await new Promise((r) => s.close(() => r()));
  }
});

async function startReplay() {
  const { createApp } = require('../services/model-replay/server.js');
  const { server, base } = await listen(createApp({ env: { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' } }));
  servers.push(server);
  return base;
}

function v1Step1Input() {
  return [
    { role: 'developer', content: PROMPT_V1 },
    { role: 'user', content: corpus[0].text },
  ];
}

test('model-client: REQUEST_MODEL is gpt-4.1-mini and the API is exported', () => {
  const mc = fresh();
  assert.equal(mc.REQUEST_MODEL, 'gpt-4.1-mini');
  assert.equal(typeof mc.getClient, 'function');
  assert.equal(typeof mc.isReplayRequest, 'function');
  assert.equal(typeof mc.replayUrl, 'function');
});

test('model-client: replayUrl() defaults to http://localhost:4200/v1', () => {
  assert.equal(fresh().replayUrl(), DEFAULT_REPLAY_URL);
});

test('model-client: replayUrl() honours REPLAY_URL', () => {
  process.env.REPLAY_URL = 'http://replay.test:9999/v1';
  assert.equal(fresh().replayUrl(), 'http://replay.test:9999/v1');
});

test('model-client: isReplayRequest is true by default (ROASTJUDGE_MODEL unset)', () => {
  const mc = fresh();
  assert.equal(mc.isReplayRequest(undefined), true);
  assert.equal(mc.isReplayRequest({ headers: {} }), true);
});

test('model-client: live only with ROASTJUDGE_MODEL=live AND OPENAI_API_KEY; header forces replay', () => {
  process.env.ROASTJUDGE_MODEL = 'live';
  assert.equal(fresh().isReplayRequest({ headers: {} }), true, 'live without a key stays replay');

  process.env.OPENAI_API_KEY = 'sk-test';
  const mc = fresh();
  assert.equal(mc.isReplayRequest({ headers: {} }), false);
  assert.equal(mc.isReplayRequest(undefined), false);
  assert.equal(mc.isReplayRequest({ headers: { 'x-roastjudge-model': 'replay' } }), true);

  delete process.env.ROASTJUDGE_MODEL;
  assert.equal(fresh().isReplayRequest({ headers: {} }), true, 'key alone does not switch to live');
});

test('model-client: getClient(undefined) returns the replay OpenAI client', () => {
  const mc = fresh();
  const c = mc.getClient(undefined);
  assert.ok(c instanceof OpenAI, 'is an openai OpenAI instance');
  assert.equal(c.baseURL, mc.replayUrl());
  assert.equal(c.baseURL, DEFAULT_REPLAY_URL);
  assert.equal(c.maxRetries, 0);
  assert.equal(c.timeout, 15000);
  assert.equal(c.apiKey, 'replay');
});

test('model-client: replay client follows REPLAY_URL', () => {
  process.env.REPLAY_URL = 'http://127.0.0.1:4999/v1';
  const c = fresh().getClient();
  assert.equal(c.baseURL, 'http://127.0.0.1:4999/v1');
});

test('model-client: live client when ROASTJUDGE_MODEL=live and OPENAI_API_KEY set', () => {
  process.env.ROASTJUDGE_MODEL = 'live';
  process.env.OPENAI_API_KEY = 'sk-test';
  const mc = fresh();
  const live = mc.getClient({ headers: {} });
  assert.ok(live instanceof OpenAI);
  assert.notEqual(live.baseURL, mc.replayUrl());
  assert.equal(live.apiKey, 'sk-test');

  const forced = mc.getClient({ headers: { 'x-roastjudge-model': 'replay' } });
  assert.ok(forced instanceof OpenAI);
  assert.equal(forced.baseURL, mc.replayUrl());
  assert.equal(forced.apiKey, 'replay');
  assert.equal(forced.maxRetries, 0);
});

test('model-client: end-to-end against the replay server returns function_call output', async () => {
  const base = await startReplay();
  process.env.REPLAY_URL = `${base}/v1`;
  const mc = fresh();
  const client = mc.getClient();
  const res = await client.responses.create({ model: mc.REQUEST_MODEL, input: v1Step1Input(), tools: [] });
  assert.equal(res.model, 'gpt-4.1-mini-2025-04-14');
  const calls = res.output.filter((i) => i.type === 'function_call');
  assert.ok(calls.length > 0, 'function_call items present');
  assert.ok(calls.some((c) => c.name === 'score_component'));
});

test('model-client: x-replay-fail request header -> InternalServerError (status 500), no retries', async () => {
  const base = await startReplay();
  process.env.REPLAY_URL = `${base}/v1`;
  const mc = fresh();
  const client = mc.getClient();
  await assert.rejects(
    client.responses.create({ model: mc.REQUEST_MODEL, input: v1Step1Input(), tools: [] }, { headers: { 'x-replay-fail': '1' } }),
    (err) => {
      assert.equal(err.constructor.name, 'InternalServerError');
      assert.equal(err.status, 500);
      return true;
    },
  );
});
