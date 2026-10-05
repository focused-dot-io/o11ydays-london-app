'use strict';

// Phase 6: scripts/load.mjs (`npm run load`), the background load generator.
// SPEC: interval LOAD_INTERVAL_MS (default 4000), seeded 30% of runs go through all three turns,
// always replay, `--once` for tests, survives app restarts (retries with backoff, never exits).
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - Target is ROASTJUDGE_URL (default http://localhost:3000). The script never loads .env and never
//    loads telemetry (plain `node scripts/load.mjs`).
//  - Every request (judge, appeal, final) carries header `x-roastjudge-model: replay` and a JSON body.
//    Turn 1: POST /judge {text: <corpus item>.text}; turn 2: POST /judge/<conversation_id>/appeal
//    {text: <same corpus item>.appeal.text}; turn 3: POST /judge/<conversation_id>/final.
//  - Corpus items come from replay/corpus.json, round-robin or seeded (either way, from the corpus).
//  - Which runs go three-turn is deterministic from a run counter + LOAD_SEED (default fixed): two
//    processes with the same LOAD_SEED produce the same three-turn pattern; about 30% of runs.
//  - LOAD_INTERVAL_MS accepts small values (the test uses 5).
//  - Flags: --once (one run, exit 0), --three-turns (force the three-turn path), --quiet.
//  - Output per run: `judge  <id-prefix>  <score>/10 <label>  trace=<32-hex trace id>` (score as the app returns it, e.g. 5.5); three-turn runs
//    add an `appeal ...` line and a `final ... ruling=<ruling>` line.
//  - When not --once, a startup line includes the target URL and the interval.
//  - Connection failure: log a line and retry with backoff (capped at <= 4000 ms), never exit.
//    With --once and an unreachable app: exit 1 after LOAD_ONCE_TIMEOUT_MS (default 5000) with a
//    message mentioning the URL or "npm run dev".

const { test, before, after } = require('node:test');
const { mainOnly } = require('./helpers/main-only.js');
const assert = require('node:assert/strict');
const { createHarness, freePort } = require('./helpers/app-harness.js');
const { createFakeJudge } = require('./helpers/fake-judge.js');
const { runNode, spawnLong, waitFor, sleep } = require('./helpers/run-script.js');

const corpus = require('../replay/corpus.json');

const JUDGE_LINE = /judge\s+\S+\s+\d+(?:\.\d+)?\/10\s+\S.*trace=([0-9a-f]{32})/;

let h;

before(async () => {
  h = await createHarness();
}, { timeout: 20000 });

after(async () => {
  if (h) await h.stop();
});

/** Reduce the fake server's request log to one entry per run: true = three-turn, false = judge only. */
function runPattern(requests) {
  const pattern = [];
  for (let i = 0; i < requests.length; i++) {
    if (requests[i].path !== '/judge') continue;
    const next = requests[i + 1];
    pattern.push(Boolean(next && /\/appeal$/.test(next.path)));
  }
  return pattern;
}

test('load --once: one judge run against the real app, exit 0, prints a real trace id', mainOnly, async () => {
  await h.resetSpans();
  const res = await runNode(['scripts/load.mjs', '--once'], { env: { ROASTJUDGE_URL: h.appUrl } });
  assert.equal(res.status, 0, res.info);
  const m = res.stdout.match(JUDGE_LINE);
  assert.ok(m, `a "judge <id> <score>/10 <label> trace=<hex>" line\n${res.info}`);

  const spans = await h.traceSpans(m[1]);
  assert.ok(spans.some((s) => s.name === 'invoke_agent roast-judge'), `trace ${m[1]} is a judge trace\n${res.info}`);
  const chats = spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'chat');
  assert.ok(chats.length >= 1, 'chat spans in the trace');
  for (const c of chats) assert.equal(c.attributes['roastjudge.model.replay'], true);
});

test('load --once --three-turns: judge, appeal and final against the real app', async () => {
  const res = await runNode(['scripts/load.mjs', '--once', '--three-turns'], { env: { ROASTJUDGE_URL: h.appUrl } });
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, JUDGE_LINE, res.info);
  assert.match(res.stdout, /^.*appeal\b.*$/m, res.info);
  assert.match(res.stdout, /final\b.*ruling=(upheld|overturned)/, res.info);
});

test('load --once: replay header, corpus text, and the three-turn request shape', async () => {
  const fake = await createFakeJudge().listen();
  try {
    const one = await runNode(['scripts/load.mjs', '--once'], { env: { ROASTJUDGE_URL: fake.url } });
    assert.equal(one.status, 0, one.info);
    assert.equal(fake.requests.length, 1, JSON.stringify(fake.requests.map((r) => r.path)));
    const [j] = fake.requests;
    assert.equal(j.method, 'POST');
    assert.equal(j.path, '/judge');
    assert.equal(j.headers['x-roastjudge-model'], 'replay');
    const item = corpus.find((c) => c.text === (j.body && j.body.text));
    assert.ok(item, `judge text is a corpus item: ${JSON.stringify(j.body)}`);

    fake.requests.length = 0;
    const three = await runNode(['scripts/load.mjs', '--once', '--three-turns'], { env: { ROASTJUDGE_URL: fake.url } });
    assert.equal(three.status, 0, three.info);
    const paths = fake.requests.map((r) => r.path);
    assert.equal(paths.length, 3, JSON.stringify(paths));
    assert.equal(paths[0], '/judge');
    const first = corpus.find((c) => c.text === fake.requests[0].body.text);
    assert.ok(first, 'turn 1 text from the corpus');
    const id = paths[1].match(/^\/judge\/([^/]+)\/appeal$/);
    assert.ok(id, JSON.stringify(paths));
    assert.equal(paths[2], `/judge/${id[1]}/final`);
    assert.ok(id[1].startsWith('fakeconv'), 'appeal goes to the conversation id from turn 1');
    assert.equal(fake.requests[1].body.text, first.appeal.text, 'appeal text is the same item\'s appeal.text');
    for (const r of fake.requests) {
      assert.equal(r.method, 'POST');
      assert.equal(r.headers['x-roastjudge-model'], 'replay', `${r.path} carries the replay header`);
    }
    assert.match(three.stdout, /ruling=overturned/, three.info);
  } finally {
    await fake.close();
  }
});

test('load: continuous mode prints a startup line, ~30% three-turn runs, deterministic per LOAD_SEED', async () => {
  const patterns = [];
  for (let round = 0; round < 2; round++) {
    const fake = await createFakeJudge().listen();
    const proc = spawnLong(process.execPath, ['scripts/load.mjs'], {
      env: { ROASTJUDGE_URL: fake.url, LOAD_INTERVAL_MS: '5', LOAD_SEED: '42' },
    });
    try {
      const ok = await waitFor(() => runPattern(fake.requests).length >= 41 || proc.exited, 8000);
      assert.ok(ok && !proc.exited, `40 runs within 8 s at LOAD_INTERVAL_MS=5\n${proc.info()}`);
      assert.ok(proc.stdout.includes(fake.url), `startup line names the target URL\n${proc.info()}`);
      for (const r of fake.requests) assert.equal(r.headers['x-roastjudge-model'], 'replay');
      patterns.push(runPattern(fake.requests).slice(0, 40));
    } finally {
      await proc.kill();
      await fake.close();
    }
  }
  const threes = patterns[0].filter(Boolean).length;
  assert.ok(threes >= 4 && threes <= 20, `about 30% of 40 runs go three-turn (got ${threes})`);
  assert.deepEqual(patterns[1], patterns[0], 'same LOAD_SEED -> same three-turn pattern');
});

test('load: survives the app being down (retries, does not exit) and resumes when it comes up', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawnLong(process.execPath, ['scripts/load.mjs'], { env: { ROASTJUDGE_URL: url, LOAD_INTERVAL_MS: '50' } });
  const fake = createFakeJudge();
  try {
    await sleep(1200);
    assert.equal(proc.exited, null, `still running while the app is down\n${proc.info()}`);
    assert.ok((proc.stdout + proc.stderr).split('\n').filter(Boolean).length >= 2, `logged the failure\n${proc.info()}`);
    await fake.listen(port);
    const ok = await waitFor(() => fake.requests.some((r) => r.path === '/judge'), 6000);
    assert.ok(ok, `a judge request arrived once the app came up\n${proc.info()}`);
    assert.equal(proc.exited, null);
  } finally {
    await proc.kill();
    await fake.close();
  }
});

test('load --once: unreachable app -> exit 1 with a message, within LOAD_ONCE_TIMEOUT_MS (default 5000)', async () => {
  const port = await freePort();
  const res = await runNode(['scripts/load.mjs', '--once'], { env: { ROASTJUDGE_URL: `http://127.0.0.1:${port}` }, timeoutMs: 9000 });
  assert.equal(res.status, 1, res.info);
  assert.ok(res.ms < 8000, `exits within ~6 s (took ${res.ms} ms)`);
  assert.match(res.out, new RegExp(`127\\.0\\.0\\.1:${port}|npm run dev`), res.info);
});
