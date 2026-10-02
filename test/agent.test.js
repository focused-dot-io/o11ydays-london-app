'use strict';

// Phase 4: src/agent.js, the hand-written agent loop (unit-ish, in-process, no telemetry).
// Real replay + pub-guide servers run in-process on ephemeral ports via their createApp().
//
// SPEC: exports { runAgent, VerdictParseError, TOOLS };
//   runAgent({ conversation, turn: 1|2|3, text, client, promptVersion, pubGuideUrl, failTool, failModel })
//     -> Promise<{ score, label, reason, ruling?, components_scored, model_calls }>
//   The developer prompt is an `input` item { role: 'developer', content }, never `instructions`.
//   failModel: true sends header `x-replay-fail: 1` on the responses.create call.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - runAgent records the turn on the `conversation` object it is given: after a successful run
//    conversation.turns.length has grown by exactly 1 (entry shape is up to the implementer), and
//    the next turn's `input` replays the earlier turns so the replay engine sees 1/2/3 user items.
//  - components_scored = number of score_component calls executed in THIS run;
//    model_calls = number of responses.create calls in THIS run.
//  - The developer item's content is the full prompt file text (prompts.getPrompt(promptVersion)),
//    and the user item's content is the `text` argument, unmodified (string, or an array of
//    { type:'input_text', text } parts).
//  - The request body has model === REQUEST_MODEL ('gpt-4.1-mini') and tools === TOOLS' definitions
//    in order; options (2nd arg to responses.create) carries headers { 'x-replay-fail': '1' } only
//    when failModel is true.
//  - A model error is rethrown as-is (the openai SDK's InternalServerError, status 500).
//  - A failing tool does not abort the run: its error is fed back to the model as the
//    function_call_output and the loop continues to a verdict.
//  - VerdictParseError: thrown when the final assistant message is not a JSON verdict.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'replay', 'corpus.json'), 'utf8'));
const { labelFor } = require('../services/model-replay/vocabulary.js');
const replayServer = require('../services/model-replay/server.js');
const pubGuideServer = require('../services/pub-guide/server.js');

const PROMPT = {
  v1: fs.readFileSync(path.join(ROOT, 'prompts', 'roast-judge.v1.md'), 'utf8'),
  v2: fs.readFileSync(path.join(ROOT, 'prompts', 'roast-judge.v2.md'), 'utf8'),
};

const loadAgent = () => require('../src/agent.js');
const loadConversations = () => require('../src/conversations.js');

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
let pubGuideUrl;

before(async () => {
  replay = await listen(replayServer.createApp({ env: { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' } }));
  pubGuide = await listen(pubGuideServer.createApp());
  pubGuideUrl = pubGuide.base;
  process.env.REPLAY_URL = `${replay.base}/v1`;
  delete process.env.ROASTJUDGE_MODEL;
});

after(async () => {
  if (replay) await close(replay.server);
  if (pubGuide) await close(pubGuide.server);
});

function replayClient() {
  return require('../src/model-client.js').getClient(undefined);
}

function newConversation() {
  return loadConversations().create();
}

function assertVerdict(r) {
  assert.equal(typeof r.score, 'number', JSON.stringify(r));
  assert.ok(r.score >= 0 && r.score <= 10, JSON.stringify(r));
  assert.equal(r.label, labelFor(r.score), JSON.stringify(r));
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
  assert.equal(typeof r.components_scored, 'number');
  assert.equal(typeof r.model_calls, 'number');
}

/** A fake openai client: records each (body, options) and answers from a queue of output arrays. */
function fakeClient(outputs) {
  const calls = [];
  const queue = [...outputs];
  return {
    calls,
    responses: {
      create: async (body, options) => {
        calls.push({ body: structuredClone(body), options: options ? structuredClone(options) : options });
        const output = queue.length > 1 ? queue.shift() : queue[0];
        return {
          id: `resp_fake${calls.length}`,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: 'gpt-4.1-mini-2025-04-14',
          status: 'completed',
          output,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
      },
    },
  };
}

function messageOutput(text) {
  return [
    {
      type: 'message',
      id: 'msg_fake',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ];
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  return '';
}

// ------------------------------------------------------------------ exports

test('agent: exports runAgent, VerdictParseError, TOOLS', () => {
  const a = loadAgent();
  assert.equal(typeof a.runAgent, 'function');
  assert.equal(typeof a.VerdictParseError, 'function');
});

test('agent: TOOLS is the three tool modules in order score_component, lookup_pub, compare_to_benchmarks', () => {
  const { TOOLS } = loadAgent();
  assert.ok(Array.isArray(TOOLS));
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ['score_component', 'lookup_pub', 'compare_to_benchmarks'],
  );
  assert.equal(TOOLS[0], require('../src/tools/score-component.js'));
  assert.equal(TOOLS[1], require('../src/tools/lookup-pub.js'));
  assert.equal(TOOLS[2], require('../src/tools/benchmarks.js'));
});

test('agent: VerdictParseError is an Error subclass named VerdictParseError', () => {
  const { VerdictParseError } = loadAgent();
  const e = new VerdictParseError('bad verdict');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof VerdictParseError);
  assert.equal(e.name, 'VerdictParseError');
  assert.equal(e.constructor.name, 'VerdictParseError');
  assert.match(e.message, /bad verdict/);
});

// ------------------------------------------------------------------ request shape (fake client)

test('agent: request body = developer prompt input item, no instructions, model gpt-4.1-mini, flat tools', async () => {
  const { runAgent, TOOLS } = loadAgent();
  const client = fakeClient([messageOutput(JSON.stringify({ score: 7, label: 'decent', reason: 'fine' }))]);
  const text = corpus[0].text;
  const r = await runAgent({ conversation: newConversation(), turn: 1, text, client, promptVersion: 'v1', pubGuideUrl });
  assert.equal(r.score, 7);
  assert.equal(r.label, 'decent');
  assert.equal(r.reason, 'fine');
  assert.equal(r.model_calls, 1);
  assert.equal(r.components_scored, 0);

  assert.equal(client.calls.length, 1);
  const { body, options } = client.calls[0];
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(body.instructions, undefined, 'the prompt must never go in `instructions`');
  assert.ok(Array.isArray(body.input), 'input is an array of items');
  assert.deepEqual(body.input[0], { role: 'developer', content: PROMPT.v1 });
  const users = body.input.filter((it) => it && it.role === 'user');
  assert.equal(users.length, 1, 'turn 1 carries exactly one user item');
  assert.equal(contentText(users[0].content), text);
  assert.deepEqual(body.tools, TOOLS.map((t) => t.definition));
  for (const t of body.tools) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.name, 'string');
    assert.equal(t.function, undefined, 'flat Responses API tools, not Chat Completions nesting');
  }
  const hdrs = (options && options.headers) || {};
  assert.equal(hdrs['x-replay-fail'], undefined, 'no fail header unless failModel');
});

test('agent: promptVersion v2 sends the v2 prompt file as the developer item', async () => {
  const { runAgent } = loadAgent();
  const client = fakeClient([messageOutput(JSON.stringify({ score: 5, label: 'disappointing', reason: 'meh' }))]);
  await runAgent({ conversation: newConversation(), turn: 1, text: corpus[1].text, client, promptVersion: 'v2', pubGuideUrl });
  assert.deepEqual(client.calls[0].body.input[0], { role: 'developer', content: PROMPT.v2 });
});

test('agent: failModel sends x-replay-fail: 1 on the responses.create call', async () => {
  const { runAgent } = loadAgent();
  const client = fakeClient([messageOutput(JSON.stringify({ score: 7, label: 'decent', reason: 'fine' }))]);
  await runAgent({
    conversation: newConversation(),
    turn: 1,
    text: corpus[0].text,
    client,
    promptVersion: 'v1',
    pubGuideUrl,
    failModel: true,
  });
  const hdrs = (client.calls[0].options && client.calls[0].options.headers) || {};
  assert.equal(String(hdrs['x-replay-fail']), '1');
});

test('agent: a non-JSON final message rejects with VerdictParseError', async () => {
  const { runAgent, VerdictParseError } = loadAgent();
  const client = fakeClient([messageOutput('not json')]);
  await assert.rejects(
    runAgent({ conversation: newConversation(), turn: 1, text: corpus[0].text, client, promptVersion: 'v1', pubGuideUrl }),
    (err) => {
      assert.ok(err instanceof VerdictParseError, `got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
      assert.equal(err.name, 'VerdictParseError');
      return true;
    },
  );
});

test('agent: tool calls from the model are executed and fed back as function_call_output', async () => {
  const { runAgent } = loadAgent();
  const client = fakeClient([
    [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_one',
        name: 'score_component',
        arguments: JSON.stringify({ component: 'gravy', notes: 'rich and glossy' }),
        status: 'completed',
      },
    ],
    messageOutput(JSON.stringify({ score: 8, label: 'banging', reason: 'gravy' })),
  ]);
  const r = await runAgent({ conversation: newConversation(), turn: 1, text: 'gravy', client, promptVersion: 'v1', pubGuideUrl });
  assert.equal(r.model_calls, 2);
  assert.equal(r.components_scored, 1);
  const second = client.calls[1].body.input;
  const call = second.find((it) => it && it.type === 'function_call');
  const out = second.find((it) => it && it.type === 'function_call_output');
  assert.ok(call, 'the function_call item is replayed back to the model');
  assert.equal(call.call_id, 'call_one');
  assert.ok(out, 'a function_call_output item follows');
  assert.equal(out.call_id, 'call_one');
  assert.equal(typeof out.output, 'string');
  const parsed = JSON.parse(out.output);
  assert.equal(parsed.component, 'gravy');
  assert.equal(typeof parsed.score, 'number');
  assert.equal(second.indexOf(call) < second.indexOf(out), true);
});

// ------------------------------------------------------------------ against the replay server

test('agent: v1 turn 1 scores every component, looks up the pub, benchmarks, then verdicts (2 model calls)', async () => {
  const { runAgent } = loadAgent();
  const conversation = newConversation();
  const item = corpus[0];
  const r = await runAgent({ conversation, turn: 1, text: item.text, client: replayClient(), promptVersion: 'v1', pubGuideUrl });
  assertVerdict(r);
  assert.equal(r.components_scored, item.components.length || 3);
  assert.equal(r.model_calls, 2);
  assert.equal(r.ruling, undefined, 'no ruling on turn 1');
  assert.equal(conversation.turns.length, 1, 'the turn is recorded on the conversation');
});

test('agent: v1 turn 1 is deterministic for the same text', async () => {
  const { runAgent } = loadAgent();
  const item = corpus[1];
  const run = () =>
    runAgent({ conversation: newConversation(), turn: 1, text: item.text, client: replayClient(), promptVersion: 'v1', pubGuideUrl });
  const a = await run();
  const b = await run();
  assert.equal(a.score, b.score);
  assert.equal(a.label, b.label);
  assert.equal(a.components_scored, b.components_scored);
});

test('agent: v2 on the same text scores at most one component and still makes >= 2 model calls', async () => {
  const { runAgent } = loadAgent();
  for (const item of corpus.slice(0, 5)) {
    const r = await runAgent({ conversation: newConversation(), turn: 1, text: item.text, client: replayClient(), promptVersion: 'v2', pubGuideUrl });
    assertVerdict(r);
    assert.ok(r.components_scored <= 1, `${item.id}: components_scored ${r.components_scored}`);
    assert.ok(r.model_calls >= 2, `${item.id}: model_calls ${r.model_calls}`);
  }
});

test('agent: three turns on one conversation (judge, appeal, final ruling)', async () => {
  const { runAgent } = loadAgent();
  const conversation = newConversation();
  const item = corpus[0];
  const base = { conversation, client: replayClient(), promptVersion: 'v1', pubGuideUrl };

  const t1 = await runAgent({ ...base, turn: 1, text: item.text });
  assertVerdict(t1);
  assert.equal(conversation.turns.length, 1);

  const t2 = await runAgent({ ...base, client: replayClient(), turn: 2, text: item.appeal.text });
  assertVerdict(t2);
  assert.ok(t2.components_scored >= 1, `appeal re-scores the disputed component: ${JSON.stringify(t2)}`);
  assert.equal(t2.model_calls, 2);
  assert.equal(conversation.turns.length, 2);

  const t3 = await runAgent({ ...base, client: replayClient(), turn: 3, text: 'Final ruling, please.' });
  assertVerdict(t3);
  assert.ok(['upheld', 'overturned'].includes(t3.ruling), `ruling: ${JSON.stringify(t3)}`);
  assert.equal(conversation.turns.length, 3);
});

test('agent: failModel against replay rejects with the SDK InternalServerError (status 500)', async () => {
  const { runAgent } = loadAgent();
  await assert.rejects(
    runAgent({
      conversation: newConversation(),
      turn: 1,
      text: corpus[0].text,
      client: replayClient(),
      promptVersion: 'v1',
      pubGuideUrl,
      failModel: true,
    }),
    (err) => {
      assert.equal(err.constructor.name, 'InternalServerError', `${err && err.constructor && err.constructor.name}: ${err && err.message}`);
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test('agent: failTool (v1) still returns a verdict: lookup_pub fails, the other tools run', async () => {
  const { runAgent } = loadAgent();
  const item = corpus[0];
  const r = await runAgent({
    conversation: newConversation(),
    turn: 1,
    text: item.text,
    client: replayClient(),
    promptVersion: 'v1',
    pubGuideUrl,
    failTool: true,
  });
  assertVerdict(r);
  assert.equal(r.components_scored, item.components.length || 3);
  assert.equal(r.model_calls, 2);
});
