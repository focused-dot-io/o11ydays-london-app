'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const loadEngine = () => require('../services/model-replay/engine.js');
const loadVocab = () => require('../services/model-replay/vocabulary.js');
const loadCorpus = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'replay', 'corpus.json'), 'utf8'));

const MODEL = 'gpt-4.1-mini';
const REPLAY_MODEL = 'gpt-4.1-mini-2025-04-14';
const LABELS = ['banging', 'decent', 'disappointing', 'a crime'];
const DEFAULT_COMPONENTS = ['meat', 'roasties', 'gravy'];

// Quiet, never-failing options for every call that is not testing latency/failure.
const QUIET = () => ({ env: { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' } });

// Distinct fake rubric scores per component so "mean of component scores" is a real check.
const FAKE_SCORES = { meat: 8, nut_roast: 5, roasties: 6, yorkshire: 9, gravy: 4, veg: 7 };
const BENCHMARKS = { pub_average: 6.5, overall_average: 6.8, sample_size: 40 };

const TOOLS = [
  {
    type: 'function',
    name: 'score_component',
    description: 'Score one component of the roast against the fixed rubric.',
    parameters: {
      type: 'object',
      properties: { component: { type: 'string' }, notes: { type: 'string' } },
      required: ['component'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'lookup_pub',
    description: "Look up a pub's price band and specialities.",
    parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    strict: false,
  },
  {
    type: 'function',
    name: 'compare_to_benchmarks',
    description: 'Compare scores to past verdicts.',
    parameters: {
      type: 'object',
      properties: { scores: { type: 'object' }, pub: { type: 'string' } },
      required: ['scores', 'pub'],
    },
    strict: false,
  },
];

function developer(version) {
  return {
    role: 'developer',
    content: `<!-- roast-judge prompt ${version} -->\n# Roast Judge\n\nYou judge Sunday roasts. Reply with a JSON verdict.`,
  };
}

function userItem(text) {
  return { role: 'user', content: text };
}

function body(input) {
  return { model: MODEL, input, tools: TOOLS };
}

const functionCalls = (output) => output.filter((i) => i.type === 'function_call');
const messages = (output) => output.filter((i) => i.type === 'message');
const args = (call) => JSON.parse(call.arguments);
const callsNamed = (output, name) => functionCalls(output).filter((c) => c.name === name);

function fakeToolOutput(call, scores) {
  const a = args(call);
  if (call.name === 'score_component') {
    const s = scores[a.component];
    return { component: a.component, score: s === undefined ? 7 : s };
  }
  if (call.name === 'lookup_pub') {
    const pub = loadVocab().pubs.find((p) => p.slug === a.slug);
    if (!pub) return { found: false, price_band: 'mid' };
    return { found: true, slug: pub.slug, name: pub.name, price_band: pub.price_band, specialities: [] };
  }
  if (call.name === 'compare_to_benchmarks') return { ...BENCHMARKS };
  throw new Error(`unexpected tool ${call.name}`);
}

/**
 * Drive one turn to completion: call the engine, answer every function_call with a fake
 * output, loop until a response carries no function_call items. Mutates `input` the way
 * the real agent does (appends the model's output items and the function_call_outputs).
 * Returns { responses, calls, verdict, input }.
 */
function runTurn(input, { scores = FAKE_SCORES, maxSteps = 8 } = {}) {
  const { respond } = loadEngine();
  const responses = [];
  const calls = [];
  for (let step = 0; step < maxSteps; step++) {
    const res = respond(body(input), {}, QUIET());
    assert.equal(res.status, 200, `step ${step + 1} status (${JSON.stringify(res.body)})`);
    responses.push(res);
    const output = res.body.output;
    input.push(...output);
    const fcs = functionCalls(output);
    if (fcs.length === 0) {
      const msgs = messages(output);
      assert.ok(msgs.length > 0, 'final response has a message item');
      const text = msgs[msgs.length - 1].content[0].text;
      return { responses, calls, verdict: JSON.parse(text), input };
    }
    for (const fc of fcs) {
      calls.push(fc);
      input.push({ type: 'function_call_output', call_id: fc.call_id, output: JSON.stringify(fakeToolOutput(fc, scores)) });
    }
  }
  assert.fail(`no final message after ${maxSteps} steps`);
}

function runJudge(version, text, opts) {
  return runTurn([developer(version), userItem(text)], opts);
}

function assertVerdictShape(verdict, { ruling = false } = {}) {
  const { labelFor } = loadVocab();
  assert.equal(typeof verdict.score, 'number');
  assert.ok(verdict.score >= 0 && verdict.score <= 10, `score ${verdict.score} in 0-10`);
  assert.equal(Math.round(verdict.score * 10) / 10, verdict.score, `score ${verdict.score} has one decimal`);
  assert.ok(LABELS.includes(verdict.label), `label ${verdict.label}`);
  assert.equal(verdict.label, labelFor(verdict.score), 'label matches labelFor(score)');
  assert.equal(typeof verdict.reason, 'string');
  assert.ok(verdict.reason.length > 0);
  if (ruling) assert.ok(['upheld', 'overturned'].includes(verdict.ruling), `ruling ${verdict.ruling}`);
  else assert.ok(!('ruling' in verdict), 'no ruling before turn 3');
}

function assertOutputItems(output) {
  let seenCall = false;
  for (const item of output) {
    if (item.type === 'function_call') {
      seenCall = true;
      assert.equal(typeof item.id, 'string');
      assert.match(item.call_id, /^call_/);
      assert.equal(typeof item.name, 'string');
      assert.equal(typeof item.arguments, 'string');
      assert.equal(typeof JSON.parse(item.arguments), 'object');
      assert.equal(item.status, 'completed');
    } else if (item.type === 'message') {
      assert.ok(!seenCall, 'function_call items come after every message item');
      assert.equal(typeof item.id, 'string');
      assert.equal(item.role, 'assistant');
      assert.equal(item.status, 'completed');
      assert.ok(Array.isArray(item.content) && item.content.length > 0);
      assert.equal(item.content[0].type, 'output_text');
      assert.equal(typeof item.content[0].text, 'string');
      assert.deepEqual(item.content[0].annotations, []);
    } else {
      assert.fail(`unexpected output item type ${item.type}`);
    }
  }
  const ids = functionCalls(output).map((c) => c.call_id);
  assert.equal(new Set(ids).size, ids.length, 'call_ids unique');
}

function noKeywordText() {
  const text = 'Absolutely smashing afternoon out with the family, would happily go again.';
  const lower = text.toLowerCase();
  const { components, pubs } = loadVocab();
  for (const k of [...components, ...pubs].flatMap((x) => x.keywords)) {
    assert.ok(!lower.includes(k.toLowerCase()), `synthetic text accidentally contains keyword "${k}"`);
  }
  return text;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------- exports / envelope

test('engine exports respond, hashSeed and PROMPT_MARKER_RE', () => {
  const e = loadEngine();
  assert.equal(typeof e.respond, 'function');
  assert.equal(typeof e.hashSeed, 'function');
  assert.ok(e.PROMPT_MARKER_RE instanceof RegExp);
});

test('PROMPT_MARKER_RE matches the v2 marker and captures v2', () => {
  const { PROMPT_MARKER_RE } = loadEngine();
  const re = new RegExp(PROMPT_MARKER_RE.source, PROMPT_MARKER_RE.flags.replace('g', ''));
  const m = re.exec('<!-- roast-judge prompt v2 -->');
  assert.ok(m, 'matches');
  assert.equal(m[1], 'v2');
  const m1 = re.exec('<!-- roast-judge prompt v1 -->\n# Roast Judge\nmore text');
  assert.ok(m1, 'matches inside multi-line content');
  assert.equal(m1[1], 'v1');
});

test('prompt files exist and their first line is exactly the marker', () => {
  const { PROMPT_MARKER_RE } = loadEngine();
  const re = new RegExp(PROMPT_MARKER_RE.source, PROMPT_MARKER_RE.flags.replace('g', ''));
  for (const v of ['v1', 'v2']) {
    const content = fs.readFileSync(path.join(ROOT, 'prompts', `roast-judge.${v}.md`), 'utf8');
    const first = content.split(/\r?\n/)[0];
    assert.equal(first, `<!-- roast-judge prompt ${v} -->`);
    assert.ok(content.split(/\r?\n/).slice(1).join('\n').trim().length > 0, `${v} prompt has a body`);
    const m = re.exec(content);
    assert.ok(m && m[1] === v, `PROMPT_MARKER_RE reads ${v} from the file`);
  }
});

test('hashSeed is deterministic and sensitive to the user text', () => {
  const { hashSeed } = loadEngine();
  const a = hashSeed('v1', 1, 'roast beef at the gravy boat');
  assert.deepEqual(hashSeed('v1', 1, 'roast beef at the gravy boat'), a);
  assert.notDeepEqual(hashSeed('v1', 1, 'roast lamb at the burnt end'), a);
});

test('success response envelope', () => {
  const { respond } = loadEngine();
  const item = loadCorpus()[0];
  const res = respond(body([developer('v1'), userItem(item.text)]), {}, QUIET());
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.object, 'response');
  assert.match(b.id, /^resp_/);
  assert.equal(b.model, REPLAY_MODEL);
  assert.equal(b.status, 'completed');
  assert.equal(typeof b.created_at, 'number');
  assert.ok(Array.isArray(b.output) && b.output.length > 0);
  const u = b.usage;
  for (const k of ['input_tokens', 'output_tokens', 'total_tokens']) {
    assert.ok(Number.isInteger(u[k]) && u[k] > 0, `usage.${k} = ${u[k]}`);
  }
  assert.equal(u.total_tokens, u.input_tokens + u.output_tokens);
  assertOutputItems(b.output);
});

test('usage is present and consistent on every step of a full v1 and v2 run', () => {
  const item = loadCorpus()[0];
  for (const v of ['v1', 'v2']) {
    const { responses } = runJudge(v, item.text);
    for (const r of responses) {
      const u = r.body.usage;
      assert.ok(Number.isInteger(u.input_tokens) && u.input_tokens > 0);
      assert.ok(Number.isInteger(u.output_tokens) && u.output_tokens > 0);
      assert.equal(u.total_tokens, u.input_tokens + u.output_tokens);
      assert.equal(r.body.model, REPLAY_MODEL);
    }
  }
});

// ---------------------------------------------------------------- v1 shape

test('v1 step 1 for every corpus item', async (t) => {
  const { respond } = loadEngine();
  for (const item of loadCorpus()) {
    await t.test(item.id, () => {
      const res = respond(body([developer('v1'), userItem(item.text)]), {}, QUIET());
      assert.equal(res.status, 200);
      const out = res.body.output;
      assertOutputItems(out);

      const expected = item.components.length ? item.components : DEFAULT_COMPONENTS;
      const scored = callsNamed(out, 'score_component').map((c) => args(c).component);
      assert.deepEqual([...scored].sort(), [...expected].sort(), 'one score_component per component');
      for (const c of callsNamed(out, 'score_component')) {
        assert.equal(typeof args(c).notes, 'string', 'score_component has notes');
      }

      const lookups = callsNamed(out, 'lookup_pub');
      assert.equal(lookups.length, 1, 'exactly one lookup_pub');
      assert.equal(args(lookups[0]).slug, item.pub);

      const bench = callsNamed(out, 'compare_to_benchmarks');
      assert.equal(bench.length, 1, 'exactly one compare_to_benchmarks');
      const ba = args(bench[0]);
      assert.equal(typeof ba.scores, 'object');
      assert.equal(ba.pub, item.pub);

      assert.equal(functionCalls(out).length, expected.length + 2, 'no other tool calls');
    });
  }
});

test('v1 step 1 with no component keywords scores meat, roasties, gravy and still looks up a pub', () => {
  const { respond } = loadEngine();
  const res = respond(body([developer('v1'), userItem(noKeywordText())]), {}, QUIET());
  assert.equal(res.status, 200);
  const out = res.body.output;
  assertOutputItems(out);
  const scored = callsNamed(out, 'score_component').map((c) => args(c).component);
  assert.deepEqual([...scored].sort(), [...DEFAULT_COMPONENTS].sort());
  const lookups = callsNamed(out, 'lookup_pub');
  assert.equal(lookups.length, 1);
  assert.equal(typeof args(lookups[0]).slug, 'string');
  assert.equal(callsNamed(out, 'compare_to_benchmarks').length, 1);
});

test('v1 full run ends in a verdict whose score is the mean component score', async (t) => {
  for (const item of loadCorpus()) {
    await t.test(item.id, () => {
      const { calls, verdict } = runJudge('v1', item.text);
      const expected = item.components.length ? item.components : DEFAULT_COMPONENTS;
      assertVerdictShape(verdict);
      const want = mean(expected.map((c) => FAKE_SCORES[c]));
      assert.ok(Math.abs(verdict.score - want) <= 0.05 + 1e-9, `score ${verdict.score} vs mean ${want}`);
      assert.equal(callsNamed(calls, 'score_component').length, expected.length);
    });
  }
});

test('v1 full run with no component keywords uses the meat/roasties/gravy mean', () => {
  const { verdict } = runJudge('v1', noKeywordText());
  assertVerdictShape(verdict);
  const want = mean(DEFAULT_COMPONENTS.map((c) => FAKE_SCORES[c]));
  assert.ok(Math.abs(verdict.score - want) <= 0.05 + 1e-9);
});

// ---------------------------------------------------------------- v2 shape

test('v2 step 1 returns only lookup_pub for every corpus item', async (t) => {
  const { respond } = loadEngine();
  for (const item of loadCorpus()) {
    await t.test(item.id, () => {
      const res = respond(body([developer('v2'), userItem(item.text)]), {}, QUIET());
      assert.equal(res.status, 200);
      const out = res.body.output;
      assertOutputItems(out);
      const fcs = functionCalls(out);
      assert.ok(fcs.length >= 1, 'at least one call');
      for (const fc of fcs) assert.equal(fc.name, 'lookup_pub', `unexpected ${fc.name}`);
      assert.equal(args(fcs[0]).slug, item.pub);
    });
  }
});

test('v2 full run makes at most one score_component call and ends in a valid verdict', async (t) => {
  for (const item of loadCorpus()) {
    await t.test(item.id, () => {
      const { calls, verdict } = runJudge('v2', item.text);
      assert.ok(callsNamed(calls, 'score_component').length <= 1, 'at most one score_component');
      assert.ok(callsNamed(calls, 'lookup_pub').length >= 1, 'lookup_pub called');
      assertVerdictShape(verdict);
    });
  }
});

test('v2 score tracks price band: premium pub beats budget pub for the same roast', () => {
  const { pubs } = loadVocab();
  const premium = pubs.find((p) => p.price_band === 'premium');
  const budget = pubs.find((p) => p.price_band === 'budget');
  assert.ok(premium && budget, 'vocabulary has a premium and a budget pub');
  const plate = (kw) => `Sunday roast at ${kw}. Plate was much the same as anywhere else, nothing to write home about.`;
  const hi = runJudge('v2', plate(premium.keywords[0]));
  const lo = runJudge('v2', plate(budget.keywords[0]));
  assert.equal(args(callsNamed(hi.calls, 'lookup_pub')[0]).slug, premium.slug);
  assert.equal(args(callsNamed(lo.calls, 'lookup_pub')[0]).slug, budget.slug);
  assert.ok(hi.verdict.score > lo.verdict.score, `premium ${hi.verdict.score} > budget ${lo.verdict.score}`);
});

test('v2 corpus-wide: mean score at premium pubs exceeds mean score at budget pubs', () => {
  const band = Object.fromEntries(loadVocab().pubs.map((p) => [p.slug, p.price_band]));
  const by = { premium: [], budget: [] };
  for (const item of loadCorpus()) {
    const b = band[item.pub];
    if (b in by) by[b].push(runJudge('v2', item.text).verdict.score);
  }
  assert.ok(by.premium.length > 0 && by.budget.length > 0, 'corpus has premium and budget items');
  assert.ok(mean(by.premium) > mean(by.budget), `premium ${mean(by.premium)} vs budget ${mean(by.budget)}`);
});

test('v2 makes fewer score_component calls than v1 across the corpus', () => {
  let v1 = 0;
  let v2 = 0;
  for (const item of loadCorpus()) {
    v1 += callsNamed(runJudge('v1', item.text).calls, 'score_component').length;
    v2 += callsNamed(runJudge('v2', item.text).calls, 'score_component').length;
  }
  assert.ok(v2 < v1, `v2 ${v2} < v1 ${v1}`);
});

// ---------------------------------------------------------------- determinism

function projection(res) {
  return {
    output: res.body.output.map((i) =>
      i.type === 'function_call'
        ? { type: i.type, call_id: i.call_id, name: i.name, arguments: i.arguments }
        : { type: i.type, text: i.content[0].text },
    ),
    usage: res.body.usage,
    latencyMs: res.latencyMs,
  };
}

test('determinism: same body twice gives identical call_ids, text, usage and latency', () => {
  const { respond } = loadEngine();
  const env = { env: { REPLAY_FAIL_EVERY: '0' } }; // non-zero latency so jitter is exercised
  for (const item of loadCorpus().slice(0, 10)) {
    for (const v of ['v1', 'v2']) {
      const a = respond(body([developer(v), userItem(item.text)]), {}, env);
      const b = respond(body([developer(v), userItem(item.text)]), {}, env);
      assert.deepEqual(projection(a), projection(b), `${item.id} ${v} step 1`);
    }
    // final step as well
    const run1 = runJudge('v1', item.text);
    const run2 = runJudge('v1', item.text);
    assert.deepEqual(run1.responses.map(projection), run2.responses.map(projection), `${item.id} full v1 run`);
  }
});

test('determinism: different user text gives different call_ids', () => {
  const { respond } = loadEngine();
  const [a, b] = loadCorpus();
  const ra = respond(body([developer('v1'), userItem(a.text)]), {}, QUIET());
  const rb = respond(body([developer('v1'), userItem(b.text)]), {}, QUIET());
  const ida = new Set(functionCalls(ra.body.output).map((c) => c.call_id));
  for (const c of functionCalls(rb.body.output)) assert.ok(!ida.has(c.call_id), `call_id ${c.call_id} reused`);
});

// ---------------------------------------------------------------- appeal and final turns

test('turn 2 (appeal) v1 re-scores the disputed component for every corpus item', async (t) => {
  const { respond } = loadEngine();
  for (const item of loadCorpus()) {
    await t.test(item.id, () => {
      const t1 = runJudge('v1', item.text);
      const input = [...t1.input, userItem(item.appeal.text)];
      const res = respond(body(input), {}, QUIET());
      assert.equal(res.status, 200);
      assertOutputItems(res.body.output);
      const scored = callsNamed(res.body.output, 'score_component').map((c) => args(c).component);
      assert.ok(scored.includes(item.appeal.component), `re-scores ${item.appeal.component}, got [${scored}]`);

      const t2 = runTurn(input);
      assertVerdictShape(t2.verdict);
    });
  }
});

test('turn 2 (appeal) v1 with a much higher re-score does not lower the verdict', () => {
  const item = loadCorpus().find((i) => i.components.length >= 2) || loadCorpus()[0];
  const low = Object.fromEntries(Object.keys(FAKE_SCORES).map((k) => [k, 3]));
  const t1 = runJudge('v1', item.text, { scores: low });
  const t2 = runTurn([...t1.input, userItem(item.appeal.text)], { scores: { ...low, [item.appeal.component]: 10 } });
  assertVerdictShape(t2.verdict);
  assert.ok(t2.verdict.score >= t1.verdict.score, `appeal ${t2.verdict.score} >= judge ${t1.verdict.score}`);
});

test('turn 2 (appeal) v2 calls lookup_pub again', () => {
  const { respond } = loadEngine();
  const item = loadCorpus()[0];
  const t1 = runJudge('v2', item.text);
  const input = [...t1.input, userItem(item.appeal.text)];
  const res = respond(body(input), {}, QUIET());
  assert.equal(res.status, 200);
  assert.ok(callsNamed(res.body.output, 'lookup_pub').length >= 1);
  assertVerdictShape(runTurn(input).verdict);
});

test('turn 3 (final) calls compare_to_benchmarks and rules upheld or overturned', async (t) => {
  const { respond } = loadEngine();
  for (const v of ['v1', 'v2']) {
    for (const item of loadCorpus()) {
      await t.test(`${v} ${item.id}`, () => {
        const t1 = runJudge(v, item.text);
        const t2 = runTurn([...t1.input, userItem(item.appeal.text)]);
        const input = [...t2.input, userItem('Give your final ruling.')];
        const res = respond(body(input), {}, QUIET());
        assert.equal(res.status, 200);
        assertOutputItems(res.body.output);
        assert.ok(callsNamed(res.body.output, 'compare_to_benchmarks').length >= 1, 'compare_to_benchmarks on final');
        const t3 = runTurn(input);
        assertVerdictShape(t3.verdict, { ruling: true });
      });
    }
  }
});

test('turn 3 (final) is upheld when nothing about the scores changed', () => {
  const item = loadCorpus()[0];
  const flat = Object.fromEntries(Object.keys(FAKE_SCORES).map((k) => [k, 7]));
  const t1 = runJudge('v1', item.text, { scores: flat });
  const t2 = runTurn([...t1.input, userItem(item.appeal.text)], { scores: flat });
  const t3 = runTurn([...t2.input, userItem('Give your final ruling.')], { scores: flat });
  assert.equal(t3.verdict.ruling, 'upheld');
});

// ---------------------------------------------------------------- latency

test('latencyMs is 0 with REPLAY_LATENCY_SCALE=0 and positive otherwise', () => {
  const { respond } = loadEngine();
  const item = loadCorpus()[0];
  const b = body([developer('v1'), userItem(item.text)]);
  const zero = respond(b, {}, { env: { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' } });
  assert.equal(zero.status, 200);
  assert.equal(zero.latencyMs, 0);
  const real = respond(b, {}, { env: { REPLAY_FAIL_EVERY: '0' } });
  assert.equal(real.status, 200);
  assert.equal(typeof real.latencyMs, 'number');
  assert.ok(real.latencyMs > 0, `latencyMs ${real.latencyMs}`);
});

// ---------------------------------------------------------------- forced failures

function assertServerError(res) {
  assert.equal(res.status, 500);
  assert.ok(res.body && res.body.error, 'error body');
  assert.equal(res.body.error.type, 'server_error');
  assert.equal(typeof res.body.error.message, 'string');
  assert.ok(res.body.error.message.length > 0);
  assert.equal(res.body.error.param, null);
  assert.equal(res.body.error.code, null);
}

test('x-replay-fail: 1 header forces an OpenAI-shaped 500', () => {
  const { respond } = loadEngine();
  const item = loadCorpus()[0];
  const res = respond(body([developer('v1'), userItem(item.text)]), { 'x-replay-fail': '1' }, QUIET());
  assertServerError(res);
});

test('REPLAY_FAIL_EVERY=3 with a shared callCounter fails every third call', () => {
  const { respond } = loadEngine();
  const item = loadCorpus()[0];
  const b = body([developer('v1'), userItem(item.text)]);
  const options = { env: { REPLAY_FAIL_EVERY: '3', REPLAY_LATENCY_SCALE: '0' }, callCounter: { n: 0 } };
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = respond(b, {}, options);
    statuses.push(res.status);
    if (res.status === 500) assertServerError(res);
  }
  assert.deepEqual(statuses, [200, 200, 500, 200, 200, 500]);
  assert.equal(options.callCounter.n, 6, 'callCounter incremented once per call');
});

test('REPLAY_FAIL_EVERY=0 never fails over 30 calls', () => {
  const { respond } = loadEngine();
  const item = loadCorpus()[0];
  const b = body([developer('v1'), userItem(item.text)]);
  const options = { env: { REPLAY_FAIL_EVERY: '0', REPLAY_LATENCY_SCALE: '0' }, callCounter: { n: 0 } };
  for (let i = 0; i < 30; i++) assert.equal(respond(b, {}, options).status, 200, `call ${i + 1}`);
});
