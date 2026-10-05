'use strict';

// Phase 5: scripts/expectations/<name>.js, the named predicate sets verify.cjs / check-spans.cjs run.
//
// SPEC: one set per checkpoint (checkpoint-0, -1, -2, -2-cut, -3, -4, main) plus module-2, each an
// array of { name, check }. Checkpoint-3's set asserts prompt attrs on chat spans; 4 asserts
// gen_ai.conversation.id absent; main asserts it equal across all three turns.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - check(ctx) -> true | string (a non-empty reason). ctx is
//      { checkpoint: string,
//        turns: [ { name: 'judge',  spans }, { name: 'appeal', spans }, { name: 'final', spans } ] }
//    where each `spans` is every span of that request's trace. verify always runs all three turns;
//    a set that only cares about turn 1 reads ctx.turns[0] and ignores the rest.
//    (SPEC.md says check(spans); the ctx object supersedes that so main/4 can see all three turns.)
//  - Predicates must work on BOTH span shapes:
//      ReadableSpan (sdk-trace-base, what verify.cjs collects in-process), and
//      the plain object test/helpers/app-child.js serialises
//        { name, kind, traceId, spanId, parentSpanId, status: { code, message }, attributes }.
//    So they read only span.name, span.kind, span.attributes, span.status.code directly, and go
//    through scripts/expectations/_util.js for ids:
//      spanId(span)   = span.spanContext?.().spanId ?? span.spanId
//      parentId(span) = span.parentSpanContext?.spanId ?? span.parentSpanId   (undefined for roots)
//      byName(spans, name) = spans.filter((s) => s.name === name)
//  - A check never throws, even on a turn with no spans (it returns a reason string instead).
//  - Names: checkpoint-1 is the same set as checkpoint-0 (same names, may simply require it);
//    checkpoint-2's names equal checkpoint-0's (same shape: no gen_ai spans at all).
//    module-2 has checks whose names mention `invoke_agent`, `execute_tool`, `chat` and
//    `gen_ai.tool.call.id`. checkpoint-3 and -4 each have a check whose name mentions `prompt` and
//    `chat` (prompt attrs on chat spans). checkpoint-4 has one whose name mentions
//    `conversation.id` and `absent`; main has one mentioning `conversation.id` and `turn`.
//  - checkpoint-2-cut = openai instrumentation on, invoke_agent filled, execute_tool blank: its set
//    asserts execute_tool spans are absent (so it fails on main).
//  - checkpoint-3 says nothing about conversation.id, so it passes on main too.

const { test, before, after } = require('node:test');
const { mainOnly } = require('./helpers/main-only.js');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHarness, ROOT } = require('./helpers/app-harness.js');

const SETS = ['checkpoint-0', 'checkpoint-1', 'checkpoint-2', 'checkpoint-2-cut', 'checkpoint-3', 'checkpoint-4', 'main', 'module-2'];
const EXP_DIR = path.join(ROOT, 'scripts', 'expectations');
const load = (name) => require(path.join(EXP_DIR, `${name}.js`));
const names = (name) => load(name).map((c) => c.name);
const REPLAY = { 'x-roastjudge-model': 'replay' };

// ------------------------------------------------------------------ shape

for (const set of SETS) {
  test(`expectations ${set}: a non-empty array of { name, check } with unique names`, () => {
    const checks = load(set);
    assert.ok(Array.isArray(checks), `${set} exports an array`);
    assert.ok(checks.length > 0, `${set} is non-empty`);
    for (const c of checks) {
      assert.equal(typeof c.name, 'string', `${set}: name is a string`);
      assert.ok(c.name.trim().length > 0, `${set}: name is non-empty`);
      assert.equal(typeof c.check, 'function', `${set}: ${c.name} has check()`);
    }
    const ns = checks.map((c) => c.name);
    assert.equal(new Set(ns).size, ns.length, `${set}: names unique: ${JSON.stringify(ns)}`);
  });
}

test('expectations: _util.js handles both ReadableSpan-like and plain serialised spans', () => {
  const util = require(path.join(EXP_DIR, '_util.js'));
  for (const fn of ['parentId', 'spanId', 'byName']) assert.equal(typeof util[fn], 'function', `_util.${fn}`);

  const readable = {
    name: 'invoke_agent roast-judge',
    spanContext: () => ({ traceId: 't1', spanId: 'aaaa' }),
    parentSpanContext: { traceId: 't1', spanId: 'pppp' },
  };
  const readableRoot = { name: 'POST /judge', spanContext: () => ({ traceId: 't1', spanId: 'rrrr' }), parentSpanContext: undefined };
  const plain = { name: 'invoke_agent roast-judge', traceId: 't1', spanId: 'bbbb', parentSpanId: 'qqqq' };
  const plainRoot = { name: 'POST /judge', traceId: 't1', spanId: 'ssss', parentSpanId: undefined };

  assert.equal(util.spanId(readable), 'aaaa');
  assert.equal(util.parentId(readable), 'pppp');
  assert.equal(util.parentId(readableRoot), undefined);
  assert.equal(util.spanId(plain), 'bbbb');
  assert.equal(util.parentId(plain), 'qqqq');
  assert.equal(util.parentId(plainRoot), undefined);
  assert.deepEqual(util.byName([readable, readableRoot, plain, plainRoot], 'invoke_agent roast-judge'), [readable, plain]);
  assert.deepEqual(util.byName([plainRoot], 'nope'), []);
});

test('expectations module-2: names cover invoke_agent, execute_tool, chat and gen_ai.tool.call.id', () => {
  const ns = names('module-2');
  for (const needle of ['invoke_agent', 'execute_tool', 'chat', 'gen_ai.tool.call.id']) {
    assert.ok(ns.some((n) => n.includes(needle)), `no module-2 check mentions ${needle}: ${JSON.stringify(ns)}`);
  }
});

test('expectations: checkpoint-1 has the same checks as checkpoint-0 (identical code)', () => {
  assert.deepEqual(names('checkpoint-1'), names('checkpoint-0'));
});

test('expectations: checkpoint-2 has the same checks as checkpoint-0 (same shape: no gen_ai spans)', () => {
  assert.deepEqual(names('checkpoint-2'), names('checkpoint-0'));
});

test('expectations: checkpoint-3 and checkpoint-4 check prompt attrs on chat spans', () => {
  for (const set of ['checkpoint-3', 'checkpoint-4']) {
    const ns = names(set);
    assert.ok(ns.some((n) => /prompt/.test(n) && /chat/.test(n)), `${set}: no prompt-on-chat check: ${JSON.stringify(ns)}`);
  }
});

test('expectations: checkpoint-4 checks gen_ai.conversation.id is absent', () => {
  const ns = names('checkpoint-4');
  assert.ok(ns.some((n) => /conversation\.id/.test(n) && /absent/i.test(n)), JSON.stringify(ns));
});

test('expectations: main checks gen_ai.conversation.id across turns', () => {
  const ns = names('main');
  assert.ok(ns.some((n) => /conversation\.id/.test(n) && /turn/i.test(n)), JSON.stringify(ns));
});

function runSet(set, ctx) {
  return load(set).map((c) => {
    let result;
    try {
      result = c.check(ctx);
    } catch (err) {
      assert.fail(`${set}: check "${c.name}" threw: ${err && err.stack}`);
    }
    assert.ok(
      result === true || (typeof result === 'string' && result.length > 0),
      `${set}: check "${c.name}" must return true or a non-empty string, got ${JSON.stringify(result)}`,
    );
    return { name: c.name, result };
  });
}

const failing = (results) => results.filter((r) => r.result !== true);
const show = (results) => results.map((r) => `${r.result === true ? 'ok  ' : 'FAIL'} ${r.name}${r.result === true ? '' : `: ${r.result}`}`).join('\n');

test('expectations: every set fails at least one check on a run with no spans, without throwing', () => {
  const empty = { checkpoint: 'x', turns: [{ name: 'judge', spans: [] }, { name: 'appeal', spans: [] }, { name: 'final', spans: [] }] };
  for (const set of SETS) {
    const results = runSet(set, { ...empty, checkpoint: set });
    assert.ok(failing(results).length >= 1, `${set} passes on an empty trace:\n${show(results)}`);
  }
});

// ------------------------------------------------------------------ against real spans (main code)

let h;
let ctx;

before(async () => {
  h = await createHarness();
  const judge = await h.judge(
    'The Gravy Boat, beef. Yorkshire soggy underneath, gravy from granules, roasties crisp.',
    { headers: REPLAY },
  );
  assert.equal(judge.status, 200, JSON.stringify(judge.body));
  const id = judge.body.conversation_id;
  const appeal = await h.appeal(id, 'That Yorkshire was enormous, surely size counts for something.', { headers: REPLAY });
  assert.equal(appeal.status, 200, JSON.stringify(appeal.body));
  const final = await h.final(id, { headers: REPLAY });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  const turns = [];
  for (const [name, res] of [['judge', judge], ['appeal', appeal], ['final', final]]) {
    turns.push({ name, spans: await h.traceSpans(res.body.trace_id) });
  }
  ctx = { checkpoint: 'main', turns };
});

after(async () => {
  if (h) await h.stop();
});

const withCheckpoint = (set) => ({ ...ctx, checkpoint: set });

for (const set of ['main', 'module-2', 'checkpoint-3']) {
  test(`expectations ${set}: every check passes on main's spans`, mainOnly, () => {
    const results = runSet(set, withCheckpoint(set));
    assert.deepEqual(failing(results), [], show(results));
  });
}

test('expectations checkpoint-4: on main, ONLY the conversation.id-absent check fails', mainOnly, () => {
  const results = runSet('checkpoint-4', withCheckpoint('checkpoint-4'));
  const bad = failing(results);
  assert.equal(bad.length, 1, show(results));
  assert.match(bad[0].name, /conversation\.id/);
  assert.match(bad[0].name, /absent/i);
});

test('expectations checkpoint-2-cut: fails on main (execute_tool spans are present)', mainOnly, () => {
  const results = runSet('checkpoint-2-cut', withCheckpoint('checkpoint-2-cut'));
  const bad = failing(results);
  assert.ok(bad.length >= 1, show(results));
  assert.ok(bad.some((r) => /execute_tool/.test(r.name) || /execute_tool/.test(r.result)), show(results));
});

for (const set of ['checkpoint-0', 'checkpoint-1', 'checkpoint-2']) {
  test(`expectations ${set}: fails on main (gen_ai spans are present)`, mainOnly, () => {
    const results = runSet(set, withCheckpoint(set));
    assert.ok(failing(results).length >= 1, show(results));
  });
}
