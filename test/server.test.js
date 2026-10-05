'use strict';

// Phase 4: src/server.js + src/agent.js end to end, under --require ./src/telemetry.js with the
// in-memory exporter (see test/helpers/app-harness.js for the process layout and env contract).
// Mirrors SPEC "Verification": Module 2 trace shape, tool call ids matching replay, ?fail=model,
// ?fail=tool, the v2 prompt switch, three turns sharing gen_ai.conversation.id, body trace_id.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - Env: the app reads PUB_GUIDE_URL (default http://localhost:4100) for lookup_pub; see harness.
//  - Span kinds are the numeric @opentelemetry/api SpanKind: INTERNAL=0, SERVER=1, CLIENT=2;
//    status codes SpanStatusCode: UNSET=0, OK=1, ERROR=2.
//  - invoke_agent is started inside the express route handler, so its parent is either the HTTP
//    SERVER span or an express instrumentation span (attribute `express.type`) that itself descends
//    from the SERVER span with only express spans in between. The SERVER span has http.route
//    `/judge` (or `/judge/:id/appeal`, `/judge/:id/final`).
//  - The agent sends the user's text unmodified as the user item content, and the full prompt file
//    text (prompts.getPrompt(version)) as the developer item, so the replay engine's call ids can be
//    recomputed here from engine.respond() (the engine is deterministic for (version, turn, text)).
//  - body.trace_id === the trace id of the request's root SERVER span; header x-trace-id === trace_id
//    on every response (including 400/404/502 and /healthz).
//  - error.type on invoke_agent for a model failure is the error's constructor name
//    (InternalServerError); on a failed execute_tool it is any non-empty string.
//  - POST /judge with no/empty `text` -> 400. POST /admin/prompt with a bad version -> 400.
//  - GET /admin/prompt reflects the runtime switch; tests restore v1 at the end.

const { test, before, after } = require('node:test');
const { mainOnly } = require('./helpers/main-only.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/app-harness.js');

const ROOT = path.join(__dirname, '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'replay', 'corpus.json'), 'utf8'));
const engine = require('../services/model-replay/engine.js');
const { labelFor } = require('../services/model-replay/vocabulary.js');

const INTERNAL = 0;
const SERVER = 1;
const CLIENT = 2;
const ERROR = 2;
const HEX32 = /^[0-9a-f]{32}$/;
const TOOL_TYPES = { score_component: 'function', lookup_pub: 'extension', compare_to_benchmarks: 'datastore' };

let h;

before(async () => {
  h = await createHarness();
}, { timeout: 20000 });

after(async () => {
  if (h) {
    try {
      await h.setPrompt('v1');
    } catch {
      // ignore
    }
    await h.stop();
  }
});

// ------------------------------------------------------------------ helpers

const named = (spans, name) => spans.filter((s) => s.name === name);
const byId = (spans) => new Map(spans.map((s) => [s.spanId, s]));
const dump = (spans) =>
  JSON.stringify(
    spans.map((s) => ({ name: s.name, kind: s.kind, id: s.spanId, parent: s.parentSpanId, status: s.status.code })),
    null,
    1,
  );

function one(spans, name) {
  const found = named(spans, name);
  assert.equal(found.length, 1, `expected exactly one "${name}" span:\n${dump(spans)}`);
  return found[0];
}

/** The HTTP SERVER span above `span`, allowing only express instrumentation spans in between. */
function serverAncestor(spans, span) {
  const ids = byId(spans);
  let cur = ids.get(span.parentSpanId);
  while (cur && cur.kind !== SERVER) {
    assert.ok(
      cur.attributes['express.type'] !== undefined,
      `"${span.name}" must sit directly under the HTTP route (only express spans in between), found "${cur.name}":\n${dump(spans)}`,
    );
    cur = ids.get(cur.parentSpanId);
  }
  assert.ok(cur, `"${span.name}" has no HTTP SERVER ancestor:\n${dump(spans)}`);
  return cur;
}

function method(serverSpan) {
  return serverSpan.attributes['http.request.method'] || serverSpan.attributes['http.method'];
}

function assertOkJudgeBody(res, { version = 'v1' } = {}) {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const b = res.body;
  assert.equal(typeof b.conversation_id, 'string');
  assert.ok(b.conversation_id.length > 0);
  assert.match(b.trace_id, HEX32);
  assert.equal(res.headers['x-trace-id'], b.trace_id);
  assert.equal(typeof b.verdict.score, 'number');
  assert.equal(b.verdict.label, labelFor(b.verdict.score));
  assert.equal(typeof b.verdict.reason, 'string');
  assert.equal(typeof b.components_scored, 'number');
  assert.equal(b.prompt_version, version);
}

/** Call ids the deterministic replay engine issues on turn 1, step 1, keyed `${name}|${call_id}`. */
function expectedTurn1Calls(version, text) {
  const { getPrompt } = require('../src/prompts.js');
  const res = engine.respond(
    {
      model: 'gpt-4.1-mini',
      input: [
        { role: 'developer', content: getPrompt(version) },
        { role: 'user', content: text },
      ],
      tools: [],
    },
    {},
    { env: { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' }, callCounter: { n: 0 } },
  );
  assert.equal(res.status, 200);
  return res.body.output.filter((o) => o.type === 'function_call').map((o) => `${o.name}|${o.call_id}`);
}

// ------------------------------------------------------------------ 1. health

test('server: GET /healthz -> 200 { ok: true } with an x-trace-id header', async () => {
  const res = await h.request('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.match(res.headers['x-trace-id'] || '', HEX32);
});

// ------------------------------------------------------------------ 2 + 3. judge and the Module 2 trace

test('server: POST /judge returns the verdict, and the trace has the Module 2 shape', mainOnly, async () => {
  const item = corpus[0];
  const res = await h.judge(item.text);
  assertOkJudgeBody(res);
  const b = res.body;
  assert.equal(b.components_scored, item.components.length || 3);

  const spans = await h.traceSpans(b.trace_id);
  // root: the HTTP SERVER span, same trace id as the body
  const roots = spans.filter((s) => !s.parentSpanId);
  assert.equal(roots.length, 1, `one root span:\n${dump(spans)}`);
  assert.equal(roots[0].kind, SERVER);
  assert.equal(roots[0].traceId, b.trace_id);

  // invoke_agent
  const agent = one(spans, 'invoke_agent roast-judge');
  const a = agent.attributes;
  assert.equal(agent.kind, INTERNAL);
  assert.equal(a['gen_ai.operation.name'], 'invoke_agent');
  assert.equal(a['gen_ai.agent.name'], 'roast-judge');
  assert.equal(a['gen_ai.prompt.name'], 'roast-judge');
  assert.equal(a['gen_ai.prompt.version'], 'v1');
  assert.equal(a['gen_ai.conversation.id'], b.conversation_id);
  assert.equal(a['roastjudge.verdict.score'], b.verdict.score);
  assert.equal(a['roastjudge.verdict.label'], b.verdict.label);
  assert.equal(a['roastjudge.components_scored'], b.components_scored);
  assert.notEqual(agent.status.code, ERROR);

  const server = serverAncestor(spans, agent);
  assert.equal(server, roots[0]);
  assert.equal(server.attributes['http.route'], '/judge');
  assert.equal(method(server), 'POST');

  // chat spans (instrumentation-openai), under invoke_agent, stamped by the span processor
  const chats = named(spans, 'chat gpt-4.1-mini');
  assert.equal(chats.length, 2, `two chat spans:\n${dump(spans)}`);
  for (const c of chats) {
    assert.equal(c.kind, CLIENT);
    assert.equal(c.parentSpanId, agent.spanId, 'chat spans are children of invoke_agent');
    assert.equal(c.attributes['gen_ai.operation.name'], 'chat');
    assert.equal(c.attributes['gen_ai.prompt.version'], 'v1');
    assert.equal(c.attributes['gen_ai.prompt.name'], 'roast-judge');
    assert.equal(c.attributes['gen_ai.conversation.id'], b.conversation_id);
    assert.equal(c.attributes['gen_ai.agent.name'], 'roast-judge');
    assert.equal(c.attributes['roastjudge.model.replay'], true);
    assert.notEqual(c.status.code, ERROR);
  }
  // order by the SDK's export order is end order; sort by finish reason instead of relying on it
  const reasons = chats.map((c) => JSON.stringify(c.attributes['gen_ai.response.finish_reasons'])).sort();
  assert.deepEqual(reasons, [JSON.stringify(['stop']), JSON.stringify(['tool_call'])].sort());
  const first = chats.find((c) => JSON.stringify(c.attributes['gen_ai.response.finish_reasons']) === '["tool_call"]');
  const last = chats.find((c) => JSON.stringify(c.attributes['gen_ai.response.finish_reasons']) === '["stop"]');
  assert.ok(first && last);

  // execute_tool spans
  const tools = spans.filter((s) => s.name.startsWith('execute_tool '));
  assert.equal(named(spans, 'execute_tool score_component').length, b.components_scored, dump(spans));
  const lookup = one(spans, 'execute_tool lookup_pub');
  const bench = one(spans, 'execute_tool compare_to_benchmarks');
  assert.equal(tools.length, b.components_scored + 2, dump(spans));
  const callIds = [];
  for (const t of tools) {
    const ta = t.attributes;
    const toolName = t.name.slice('execute_tool '.length);
    assert.equal(t.kind, INTERNAL, t.name);
    assert.equal(t.parentSpanId, agent.spanId, `${t.name} is a child of invoke_agent`);
    assert.equal(ta['gen_ai.operation.name'], 'execute_tool');
    assert.equal(ta['gen_ai.tool.name'], toolName);
    assert.equal(ta['gen_ai.tool.type'], TOOL_TYPES[toolName]);
    assert.equal(typeof ta['gen_ai.tool.call.id'], 'string');
    assert.match(ta['gen_ai.tool.call.id'], /^call_./);
    assert.notEqual(t.status.code, ERROR, t.name);
    callIds.push(`${toolName}|${ta['gen_ai.tool.call.id']}`);
  }
  assert.equal(new Set(callIds.map((c) => c.split('|')[1])).size, callIds.length, 'call ids are unique');

  // gen_ai.tool.call.id matches what the (deterministic) replay model issued
  assert.deepEqual([...callIds].sort(), expectedTurn1Calls('v1', item.text).sort());

  // lookup_pub crosses into pub-guide (undici CLIENT span under the tool span)
  const lookupClients = spans.filter((s) => s.parentSpanId === lookup.spanId && s.kind === CLIENT);
  assert.ok(
    lookupClients.some((s) => String(s.attributes['url.full'] || s.attributes['http.url'] || '').includes('/pubs/')),
    `lookup_pub has an HTTP CLIENT child to /pubs/:\n${dump(spans)}`,
  );

  // compare_to_benchmarks has its hand-written sqlite CLIENT span
  const select = spans.filter((s) => s.parentSpanId === bench.spanId && s.name === 'SELECT verdicts');
  assert.equal(select.length, 1, `SELECT verdicts under compare_to_benchmarks:\n${dump(spans)}`);
  assert.equal(select[0].kind, CLIENT);
  assert.equal(select[0].attributes['db.system.name'], 'sqlite');
});

test('server: x-roastjudge-model: replay header is accepted', async () => {
  const res = await h.judge(corpus[2].text, { headers: { 'x-roastjudge-model': 'replay' } });
  assertOkJudgeBody(res);
});

test('server: POST /judge without text -> 400 (with x-trace-id)', async () => {
  const res = await h.judge(undefined);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.headers['x-trace-id'] || '', HEX32);
  const res2 = await h.judge('');
  assert.equal(res2.status, 400, JSON.stringify(res2.body));
});

// ------------------------------------------------------------------ 4. forced model failure

test('server: ?fail=model -> 502 model_error; chat span and invoke_agent are ERROR / InternalServerError', mainOnly, async () => {
  const res = await h.judge(corpus[3].text, { query: { fail: 'model' } });
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.error, 'model_error');
  assert.equal(typeof res.body.message, 'string');
  assert.ok(res.body.message.length > 0);
  assert.match(res.body.trace_id, HEX32);
  assert.equal(res.headers['x-trace-id'], res.body.trace_id);

  const spans = await h.traceSpans(res.body.trace_id);
  const agent = one(spans, 'invoke_agent roast-judge');
  assert.equal(agent.status.code, ERROR);
  assert.equal(agent.attributes['error.type'], 'InternalServerError');

  const chats = named(spans, 'chat gpt-4.1-mini');
  assert.ok(chats.length >= 1, dump(spans));
  const failed = chats.filter((c) => c.status.code === ERROR);
  assert.equal(failed.length, 1, dump(spans));
  assert.equal(failed[0].attributes['error.type'], 'InternalServerError');
  assert.equal(failed[0].parentSpanId, agent.spanId);
  assert.equal(named(spans, 'execute_tool lookup_pub').length, 0, 'no tools ran');
});

// ------------------------------------------------------------------ 5. forced tool failure

test('server: ?fail=tool -> 200 verdict; execute_tool lookup_pub is ERROR, invoke_agent is not', mainOnly, async () => {
  const item = corpus[0];
  const res = await h.judge(item.text, { query: { fail: 'tool' } });
  assertOkJudgeBody(res);

  const spans = await h.traceSpans(res.body.trace_id);
  const agent = one(spans, 'invoke_agent roast-judge');
  assert.notEqual(agent.status.code, ERROR);
  const lookup = one(spans, 'execute_tool lookup_pub');
  assert.equal(lookup.status.code, ERROR);
  assert.equal(typeof lookup.attributes['error.type'], 'string');
  assert.ok(lookup.attributes['error.type'].length > 0);
  for (const t of spans.filter((s) => s.name.startsWith('execute_tool ') && s !== lookup)) {
    assert.notEqual(t.status.code, ERROR, `${t.name} should succeed`);
  }
  assert.equal(named(spans, 'chat gpt-4.1-mini').length, 2);
});

// ------------------------------------------------------------------ 6. prompt switch

test('server: /admin/prompt switches v1 -> v2 at runtime; v2 stamps every span and scores less', mainOnly, async () => {
  try {
    const g = await h.getPrompt();
    assert.equal(g.status, 200);
    assert.deepEqual(g.body, { version: 'v1' });

    const s = await h.setPrompt('v2');
    assert.equal(s.status, 200);
    assert.deepEqual(s.body, { version: 'v2' });
    assert.deepEqual((await h.getPrompt()).body, { version: 'v2' });

    const item = corpus[0];
    const res = await h.judge(item.text);
    assertOkJudgeBody(res, { version: 'v2' });
    assert.ok(res.body.components_scored <= 1, JSON.stringify(res.body));

    const spans = await h.traceSpans(res.body.trace_id);
    const agent = one(spans, 'invoke_agent roast-judge');
    assert.equal(agent.attributes['gen_ai.prompt.version'], 'v2');
    assert.equal(agent.attributes['roastjudge.components_scored'], res.body.components_scored);
    const chats = named(spans, 'chat gpt-4.1-mini');
    assert.ok(chats.length >= 2, dump(spans));
    for (const c of chats) assert.equal(c.attributes['gen_ai.prompt.version'], 'v2');
    assert.ok(named(spans, 'execute_tool lookup_pub').length >= 1, 'v2 looks the pub up');
    assert.ok(named(spans, 'execute_tool score_component').length <= 1);

    const bad = await h.setPrompt('v9');
    assert.equal(bad.status, 400);
    assert.deepEqual((await h.getPrompt()).body, { version: 'v2' }, 'a bad version leaves the switch alone');
  } finally {
    await h.setPrompt('v1');
  }
  assert.deepEqual((await h.getPrompt()).body, { version: 'v1' });
});

// ------------------------------------------------------------------ 7. three turns

test('server: judge -> appeal -> final share one conversation_id across three traces', mainOnly, async () => {
  const item = corpus[0];
  const t1 = await h.judge(item.text);
  assertOkJudgeBody(t1);
  const id = t1.body.conversation_id;

  const t2 = await h.appeal(id, item.appeal.text);
  assertOkJudgeBody(t2);
  assert.equal(t2.body.conversation_id, id);
  assert.ok(t2.body.components_scored >= 1, JSON.stringify(t2.body));

  const t3 = await h.final(id);
  assertOkJudgeBody(t3);
  assert.equal(t3.body.conversation_id, id);
  assert.ok(['upheld', 'overturned'].includes(t3.body.verdict.ruling), JSON.stringify(t3.body));

  const traceIds = [t1.body.trace_id, t2.body.trace_id, t3.body.trace_id];
  assert.equal(new Set(traceIds).size, 3, 'three distinct traces');

  const routes = ['/judge', '/judge/:id/appeal', '/judge/:id/final'];
  for (let i = 0; i < 3; i++) {
    const spans = await h.traceSpans(traceIds[i]);
    const agent = one(spans, 'invoke_agent roast-judge');
    assert.equal(agent.attributes['gen_ai.conversation.id'], id, `turn ${i + 1}`);
    assert.equal(agent.attributes['gen_ai.agent.name'], 'roast-judge');
    const server = serverAncestor(spans, agent);
    assert.equal(server.attributes['http.route'], routes[i], `turn ${i + 1}`);
    for (const c of named(spans, 'chat gpt-4.1-mini')) {
      assert.equal(c.attributes['gen_ai.conversation.id'], id, `turn ${i + 1} chat span`);
    }
  }
  // turn 2 re-scores, turn 3 benchmarks
  const s2 = await h.traceSpans(traceIds[1]);
  assert.ok(named(s2, 'execute_tool score_component').length >= 1, dump(s2));
  const s3 = await h.traceSpans(traceIds[2]);
  assert.ok(named(s3, 'execute_tool compare_to_benchmarks').length >= 1, dump(s3));
});

test('server: appeal / final on an unknown conversation -> 404 (with x-trace-id)', async () => {
  const a = await h.appeal('no-such-conversation', 'the Yorkshire was perfect');
  assert.equal(a.status, 404, JSON.stringify(a.body));
  assert.match(a.headers['x-trace-id'] || '', HEX32);
  const f = await h.final('no-such-conversation');
  assert.equal(f.status, 404, JSON.stringify(f.body));
});
