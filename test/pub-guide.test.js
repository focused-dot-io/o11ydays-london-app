'use strict';

// Phase 2: services/pub-guide/server.js + services/pub-guide/pubs.json

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBS_JSON = path.join(ROOT, 'services', 'pub-guide', 'pubs.json');
const FAILING_SLUG = 'the-condemned-arms';
const { pubs: VOCAB_PUBS } = require('../services/model-replay/vocabulary.js');

/** Listen on an ephemeral port; accepts an express app, an http.Server or a request handler. */
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

let base;
let server;

before(async () => {
  const { createApp } = require('../services/pub-guide/server.js');
  ({ server, base } = await listen(createApp()));
});

after(async () => {
  if (server) await close(server);
});

test('pub-guide: exports createApp() which returns an app', () => {
  const mod = require('../services/pub-guide/server.js');
  assert.equal(typeof mod.createApp, 'function');
  const app = mod.createApp();
  assert.ok(app, 'createApp() returned something');
  assert.equal(typeof app, 'function', 'express app is a request handler function');
});

test('pub-guide: GET /healthz -> 200 {ok:true}', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await res.json(), { ok: true });
});

test('pub-guide: GET /pubs/<slug> for every vocabulary pub -> found with vocabulary name and price band', async () => {
  for (const p of VOCAB_PUBS) {
    const res = await fetch(`${base}/pubs/${p.slug}`);
    assert.equal(res.status, 200, `status for ${p.slug}`);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.found, true, `${p.slug} found`);
    assert.equal(body.slug, p.slug);
    assert.equal(body.name, p.name, `${p.slug} name`);
    assert.equal(body.price_band, p.price_band, `${p.slug} price_band`);
    assert.ok(Array.isArray(body.specialities) && body.specialities.length > 0, `${p.slug} specialities non-empty`);
    for (const s of body.specialities) assert.equal(typeof s, 'string');
    assert.equal(typeof body.reputation, 'string');
    assert.ok(body.reputation.length > 0, `${p.slug} reputation non-empty`);
  }
});

test('pub-guide: unknown slug -> 200 {found:false, price_band:"mid"}', async () => {
  const res = await fetch(`${base}/pubs/no-such-pub`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.found, false);
  assert.equal(body.price_band, 'mid');
  if ('slug' in body) assert.equal(body.slug, 'no-such-pub');
});

test('pub-guide: reserved slug the-condemned-arms -> 500 with a JSON error body', async () => {
  const res = await fetch(`${base}/pubs/${FAILING_SLUG}`);
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.ok(body && body.error, 'body has an error field');
});

test('pub-guide: pubs.json covers exactly the vocabulary pubs, well-formed, never the reserved slug', () => {
  const data = JSON.parse(fs.readFileSync(PUBS_JSON, 'utf8'));
  assert.ok(Array.isArray(data), 'pubs.json is an array');
  const slugs = data.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'no duplicate slugs');
  assert.ok(!slugs.includes(FAILING_SLUG), 'reserved failing slug is not in pubs.json');
  assert.deepEqual([...slugs].sort(), VOCAB_PUBS.map((p) => p.slug).sort(), 'same set of slugs as the vocabulary');
  for (const p of data) {
    const v = VOCAB_PUBS.find((x) => x.slug === p.slug);
    assert.equal(p.name, v.name, `${p.slug} name`);
    assert.equal(p.price_band, v.price_band, `${p.slug} price_band`);
    assert.ok(['budget', 'mid', 'premium'].includes(p.price_band));
    assert.ok(Array.isArray(p.specialities) && p.specialities.length > 0, `${p.slug} specialities`);
    assert.equal(typeof p.reputation, 'string');
    assert.ok(p.reputation.length > 0);
  }
});
