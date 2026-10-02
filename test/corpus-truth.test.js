'use strict';

// Phase 5: the corpus tells the truth about the REAL pipeline (agent loop + replay + real tools).
//
// ASSUMPTIONS (beyond SPEC.md; the corpus author must follow these):
//  - expected_v1_label is the label runAgent produces for the item's text on prompt v1, turn 1
//    (real score_component rubric, real pub-guide, replay model), not a hand-picked guess.
//    All four labels still appear across the corpus.
//  - Every item has appeal.expected_ruling, 'upheld' or 'overturned': the `ruling` the real pipeline
//    returns on turn 3 after judge (item.text) -> appeal (item.appeal.text) -> final
//    ('Give your final ruling.', the text src/server.js sends), all on v1.
//  - Overturn bias: between 4 and 8 items inclusive (10-20% of 40) end `overturned`; every other
//    item ends `upheld`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'replay', 'corpus.json'), 'utf8'));
const replayServer = require('../services/model-replay/server.js');
const pubGuideServer = require('../services/pub-guide/server.js');

const LABELS = ['banging', 'decent', 'disappointing', 'a crime'];
const RULINGS = ['upheld', 'overturned'];
const FINAL_TEXT = 'Give your final ruling.';

function listen(app) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, base: `http://127.0.0.1:${srv.address().port}` }));
    srv.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

let replay;
let pubGuide;
const results = new Map(); // id -> { label, ruling, scores: [t1, t2, t3], error }

before(async () => {
  replay = await listen(replayServer.createApp({ env: { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' } }));
  pubGuide = await listen(pubGuideServer.createApp());
  process.env.REPLAY_URL = `${replay.base}/v1`;
  delete process.env.ROASTJUDGE_MODEL;

  const { runAgent } = require('../src/agent.js');
  const conversations = require('../src/conversations.js');
  const { getClient } = require('../src/model-client.js');

  await Promise.all(
    corpus.map(async (item) => {
      try {
        const conversation = conversations.create();
        const base = { conversation, promptVersion: 'v1', pubGuideUrl: pubGuide.base };
        const t1 = await runAgent({ ...base, client: getClient(undefined), turn: 1, text: item.text });
        const t2 = await runAgent({ ...base, client: getClient(undefined), turn: 2, text: item.appeal.text });
        const t3 = await runAgent({ ...base, client: getClient(undefined), turn: 3, text: FINAL_TEXT });
        results.set(item.id, { label: t1.label, ruling: t3.ruling, scores: [t1.score, t2.score, t3.score] });
      } catch (err) {
        results.set(item.id, { error: String((err && err.stack) || err) });
      }
    }),
  );
});

after(async () => {
  if (replay) await close(replay.server);
  if (pubGuide) await close(pubGuide.server);
});

test('corpus truth: every item runs through all three v1 turns without error', () => {
  const errors = corpus.filter((i) => results.get(i.id).error).map((i) => `${i.id}: ${results.get(i.id).error}`);
  assert.deepEqual(errors, []);
});

test("corpus truth: expected_v1_label equals the real pipeline's turn-1 label for every item", () => {
  const wrong = corpus
    .filter((i) => results.get(i.id).label !== i.expected_v1_label)
    .map((i) => `${i.id}: expected_v1_label ${JSON.stringify(i.expected_v1_label)} but the pipeline says ${JSON.stringify(results.get(i.id).label)} (score ${results.get(i.id).scores && results.get(i.id).scores[0]})`);
  assert.deepEqual(wrong, []);
});

test('corpus truth: all four labels appear among the real turn-1 labels', () => {
  const seen = new Set(corpus.map((i) => results.get(i.id).label));
  for (const l of LABELS) assert.ok(seen.has(l), `label ${l} never produced; seen ${JSON.stringify([...seen])}`);
});

test('corpus truth: every item has appeal.expected_ruling upheld|overturned', () => {
  for (const item of corpus) {
    assert.ok(item.appeal && RULINGS.includes(item.appeal.expected_ruling), `${item.id}: appeal.expected_ruling ${JSON.stringify(item.appeal && item.appeal.expected_ruling)}`);
  }
});

test("corpus truth: appeal.expected_ruling equals the real pipeline's final ruling", () => {
  const wrong = corpus
    .filter((i) => results.get(i.id).ruling !== (i.appeal && i.appeal.expected_ruling))
    .map((i) => `${i.id}: expected_ruling ${JSON.stringify(i.appeal && i.appeal.expected_ruling)} but the pipeline rules ${JSON.stringify(results.get(i.id).ruling)} (scores ${JSON.stringify(results.get(i.id).scores)})`);
  assert.deepEqual(wrong, []);
});

test('corpus truth: 4-8 items are overturned on appeal (10-20%), the rest upheld', () => {
  const rulings = corpus.map((i) => results.get(i.id).ruling);
  const overturned = rulings.filter((r) => r === 'overturned').length;
  const upheld = rulings.filter((r) => r === 'upheld').length;
  assert.ok(overturned >= 4 && overturned <= 8, `overturned ${overturned} of ${corpus.length}`);
  assert.equal(upheld, corpus.length - overturned, `every other item is upheld: ${JSON.stringify(rulings)}`);
});
