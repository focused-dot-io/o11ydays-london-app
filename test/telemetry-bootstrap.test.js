'use strict';

// Phase 3: src/telemetry.js and services/pub-guide/telemetry.js as --require side-effect modules.
// Each test spawns a fresh node process with a fully controlled env (only PATH/HOME are inherited;
// no OTEL_* variables leak in from the parent).
//
// ASSUMPTIONS beyond SPEC.md (the implementer must follow these):
// - Env: ROASTJUDGE_EXPORTER=otlp|console|memory (default otlp), HONEYCOMB_API_KEY, SEAT (default 0),
//   OTEL_SERVICE_NAME, REPLAY_URL, OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT.
// - service.name = OTEL_SERVICE_NAME || `roast-judge-${SEAT}`; resource attribute `seat` = SEAT
//   (string '7' or number 7 both accepted). pub-guide: service.name = 'pub-guide' (no seat suffix).
// - console exporter = ConsoleSpanExporter (console.dir of { resource: { attributes }, name, ... }).
//   Regexes used on stdout:
//     /['"]?service\.name['"]?\s*:\s*['"]roast-judge-7['"]/
//     /\bseat['"]?\s*:\s*['"]?7['"]?/
//     /name:\s*['"]demo['"]/  (span name)
// - otlp without HONEYCOMB_API_KEY: write a warning containing the literal `HONEYCOMB_API_KEY`
//   to stderr, fall back to the console exporter, exit normally.
// - `require('./src/telemetry.js')` from the script returns the same (cached) module that --require
//   loaded: exports { sdk, memoryExporter, ... }; memoryExporter is an InMemorySpanExporter only for
//   ROASTJUDGE_EXPORTER=memory, else null. Scripts read memoryExporter spans after forceFlush() on the
//   global tracer provider's delegate and BEFORE sdk.shutdown() (InMemorySpanExporter.shutdown()
//   clears its spans). The console exporter's output must be flushed by sdk.shutdown().
// - services/pub-guide/telemetry.js exports at least { sdk } (sdk.shutdown()).
// - The SDK must not hang the process after sdk.shutdown() (scripts exit by draining the event loop).
// - The InheritAttributesSpanProcessor wired in telemetry.js reads REPLAY_URL lazily (at span start),
//   because the script below sets process.env.REPLAY_URL after --require ran.
// - instrumentation-openai 0.20.0 (Responses path) emits gen_ai.input/output.messages log records
//   ALWAYS (content-stripped when capture is off). So telemetry.js must only copy them onto spans when
//   OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true (e.g. register ContentToSpanLogProcessor
//   only then). With capture off the chat span carries NO gen_ai.input.messages / output.messages.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SPANS_TAG = '__SPANS__';
// Scripts never call process.exit(): stdout to a pipe is async, and exiting early drops the
// console exporter's output. They let the event loop drain (the spawn timeout guards hangs).

function run(script, env, requireFile = './src/telemetry.js') {
  const res = spawnSync(
    process.execPath,
    ['--require', requireFile, '--disable-warning=ExperimentalWarning', '-e', script],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      encoding: 'utf8',
      timeout: 20000,
    },
  );
  const info = `exit=${res.status} signal=${res.signal}\n--- stderr ---\n${res.stderr}\n--- stdout ---\n${res.stdout}`;
  return { ...res, info };
}

function spansFrom(res) {
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith(SPANS_TAG));
  assert.ok(line, `no ${SPANS_TAG} line in output\n${res.info}`);
  return JSON.parse(line.slice(SPANS_TAG.length));
}

// InMemorySpanExporter.shutdown() clears its finished spans, so scripts read them after a
// forceFlush of the global tracer provider and only then call sdk.shutdown().
const FLUSH = `
async function flush() {
  const tp = require('@opentelemetry/api').trace.getTracerProvider();
  const real = typeof tp.getDelegate === 'function' ? tp.getDelegate() : tp;
  if (typeof real.forceFlush === 'function') await real.forceFlush();
}`;

const DEMO_SCRIPT = `
const api = require('@opentelemetry/api');
const t = require('./src/telemetry.js');
api.trace.getTracer('test').startSpan('demo').end();
t.sdk.shutdown().catch((e) => { console.error(e); process.exitCode = 1; });
`;

const SERVICE_7 = /['"]?service\.name['"]?\s*:\s*['"]roast-judge-7['"]/;
const SEAT_7 = /\bseat['"]?\s*:\s*['"]?7['"]?/;
const DEMO_NAME = /name:\s*['"]demo['"]/;

test('console exporter prints the span with service.name roast-judge-<SEAT> and seat resource', () => {
  const res = run(DEMO_SCRIPT, { ROASTJUDGE_EXPORTER: 'console', SEAT: '7' });
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, DEMO_NAME, res.info);
  assert.match(res.stdout, SERVICE_7, res.info);
  assert.match(res.stdout, SEAT_7, res.info);
});

test('otlp without HONEYCOMB_API_KEY warns loudly on stderr and falls back to console', () => {
  const res = run(DEMO_SCRIPT, { ROASTJUDGE_EXPORTER: 'otlp', SEAT: '7' });
  assert.equal(res.status, 0, res.info);
  assert.match(res.stderr, /HONEYCOMB_API_KEY/, res.info);
  assert.match(res.stdout, DEMO_NAME, res.info);
});

test('default exporter is otlp: no key means the same warning and console fallback', () => {
  const res = run(DEMO_SCRIPT, { SEAT: '7' });
  assert.equal(res.status, 0, res.info);
  assert.match(res.stderr, /HONEYCOMB_API_KEY/, res.info);
  assert.match(res.stdout, DEMO_NAME, res.info);
});

test('memory exporter exposes finished spans; console has memoryExporter === null', () => {
  const script = `
const api = require('@opentelemetry/api');
const t = require('./src/telemetry.js');
api.trace.getTracer('test').startSpan('demo').end();
${FLUSH}
flush().then(() => {
  console.log('${SPANS_TAG}' + JSON.stringify(t.memoryExporter.getFinishedSpans().map((s) => s.name)));
  return t.sdk.shutdown();
}).catch((e) => { console.error(e); process.exitCode = 1; });
`;
  const res = run(script, { ROASTJUDGE_EXPORTER: 'memory', SEAT: '7' });
  assert.equal(res.status, 0, res.info);
  assert.deepEqual(spansFrom(res), ['demo']);

  const nullScript = `
const t = require('./src/telemetry.js');
console.log('${SPANS_TAG}' + JSON.stringify({ isNull: t.memoryExporter === null }));
t.sdk.shutdown();
`;
  const res2 = run(nullScript, { ROASTJUDGE_EXPORTER: 'console', SEAT: '7' });
  assert.equal(res2.status, 0, res2.info);
  assert.deepEqual(spansFrom(res2), { isNull: true });
});

test('telemetry.js exports the processors and INHERITED_KEYS', () => {
  const script = `
const t = require('./src/telemetry.js');
const p = require('./src/telemetry/processors.js');
console.log('${SPANS_TAG}' + JSON.stringify({
  inherit: t.InheritAttributesSpanProcessor === p.InheritAttributesSpanProcessor,
  content: t.ContentToSpanLogProcessor === p.ContentToSpanLogProcessor,
  keys: t.INHERITED_KEYS,
  hasSdk: typeof t.sdk.shutdown === 'function',
}));
t.sdk.shutdown();
`;
  const res = run(script, { ROASTJUDGE_EXPORTER: 'memory' });
  assert.equal(res.status, 0, res.info);
  assert.deepEqual(spansFrom(res), {
    inherit: true,
    content: true,
    keys: ['gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.conversation.id', 'gen_ai.agent.name'],
    hasSdk: true,
  });
});

test('OTEL_SERVICE_NAME overrides roast-judge-<SEAT>', () => {
  const res = run(DEMO_SCRIPT, { ROASTJUDGE_EXPORTER: 'console', SEAT: '7', OTEL_SERVICE_NAME: 'custom-name' });
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /['"]?service\.name['"]?\s*:\s*['"]custom-name['"]/, res.info);
  assert.doesNotMatch(res.stdout, /roast-judge-7/, res.info);
});

test('SEAT defaults to 0', () => {
  const res = run(DEMO_SCRIPT, { ROASTJUDGE_EXPORTER: 'console' });
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /['"]?service\.name['"]?\s*:\s*['"]roast-judge-0['"]/, res.info);
});

test('http and undici instrumentations are registered (SERVER + CLIENT spans)', () => {
  const script = `
const http = require('node:http');
const t = require('./src/telemetry.js');
${FLUSH}
const srv = http.createServer((req, res) => { res.end('ok'); });
srv.listen(0, '127.0.0.1', async () => {
  try {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/hello');
    await r.text();
  } catch (e) { console.error(e); }
  srv.close();
  await new Promise((r) => setTimeout(r, 50));
  await flush();
  console.log('${SPANS_TAG}' + JSON.stringify(t.memoryExporter.getFinishedSpans().map((s) => ({ name: s.name, kind: s.kind }))));
  await t.sdk.shutdown();
});
`;
  const res = run(script, { ROASTJUDGE_EXPORTER: 'memory' });
  assert.equal(res.status, 0, res.info);
  const spans = spansFrom(res);
  const client = spans.filter((s) => s.kind === 2 && /^GET/.test(s.name)); // SpanKind.CLIENT
  const server = spans.filter((s) => s.kind === 1); // SpanKind.SERVER
  assert.ok(client.length >= 1, `expected a CLIENT GET span: ${JSON.stringify(spans)}\n${res.info}`);
  assert.ok(server.length >= 1, `expected a SERVER span: ${JSON.stringify(spans)}\n${res.info}`);
});

// One responses.create call against an in-process replay server on an ephemeral port.
function openaiScript({ fail = false } = {}) {
  return `
const t = require('./src/telemetry.js');
${FLUSH}
const { createApp } = require('./services/model-replay/server.js');
const app = createApp({ env: { REPLAY_LATENCY_SCALE: '0', REPLAY_FAIL_EVERY: '0' } });
const srv = app.listen(0, '127.0.0.1', async () => {
  process.env.REPLAY_URL = 'http://127.0.0.1:' + srv.address().port + '/v1';
  const { getClient, REQUEST_MODEL } = require('./src/model-client.js');
  const body = {
    model: REQUEST_MODEL,
    input: [
      { role: 'developer', content: '<!-- roast-judge prompt v1 -->\\nx' },
      { role: 'user', content: 'The Gravy Boat, beef, roasties crisp, gravy from granules.' },
    ],
    tools: [],
  };
  let outcome = 'ok';
  try {
    await getClient().responses.create(body${fail ? ", { headers: { 'x-replay-fail': '1' } }" : ''});
  } catch (e) {
    outcome = 'threw:' + (e && e.constructor && e.constructor.name);
  }
  await new Promise((r) => setTimeout(r, 50));
  if (srv.closeAllConnections) srv.closeAllConnections();
  srv.close();
  await flush();
  const spans = t.memoryExporter.getFinishedSpans().map((s) => ({
    name: s.name, kind: s.kind, attributes: s.attributes, status: s.status,
  }));
  console.log('${SPANS_TAG}' + JSON.stringify({ outcome, spans }));
  await t.sdk.shutdown();
});
`;
}

function chatSpanOf(res) {
  const { outcome, spans } = spansFrom(res);
  const chats = spans.filter((s) => s.name.startsWith('chat'));
  assert.equal(chats.length, 1, `expected exactly one chat span: ${JSON.stringify(spans.map((s) => s.name))}\n${res.info}`);
  return { outcome, chat: chats[0], spans };
}

test('openai instrumentation produces a Responses-API chat span against replay (content off)', () => {
  const res = run(openaiScript(), { ROASTJUDGE_EXPORTER: 'memory' });
  assert.equal(res.status, 0, res.info);
  const { outcome, chat } = chatSpanOf(res);
  assert.equal(outcome, 'ok', res.info);
  const a = chat.attributes;
  assert.equal(chat.kind, 2, 'chat span is CLIENT');
  assert.equal(a['gen_ai.operation.name'], 'chat');
  assert.equal(a['gen_ai.provider.name'], 'openai');
  assert.equal(a['gen_ai.request.model'], 'gpt-4.1-mini');
  assert.equal(a['gen_ai.response.model'], 'gpt-4.1-mini-2025-04-14');
  assert.deepEqual(a['gen_ai.response.finish_reasons'], ['tool_call']);
  assert.ok(a['gen_ai.usage.input_tokens'] > 0, JSON.stringify(a));
  assert.ok(a['gen_ai.usage.output_tokens'] > 0, JSON.stringify(a));
  assert.ok(a['server.address'], 'server.address set');
  assert.equal(a['roastjudge.model.replay'], true, JSON.stringify(a));
  assert.equal(a['gen_ai.input.messages'], undefined, 'no content when capture is off');
  assert.equal(a['gen_ai.output.messages'], undefined, 'no content when capture is off');
});

test('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true puts messages on the chat span', () => {
  const res = run(openaiScript(), {
    ROASTJUDGE_EXPORTER: 'memory',
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true',
  });
  assert.equal(res.status, 0, res.info);
  const { outcome, chat } = chatSpanOf(res);
  assert.equal(outcome, 'ok', res.info);
  const a = chat.attributes;
  assert.equal(typeof a['gen_ai.input.messages'], 'string', JSON.stringify(a));
  assert.equal(typeof a['gen_ai.output.messages'], 'string', JSON.stringify(a));
  assert.match(a['gen_ai.input.messages'], /Gravy Boat/);
  assert.match(a['gen_ai.output.messages'], /lookup_pub/);
  assert.doesNotThrow(() => JSON.parse(a['gen_ai.input.messages']));
  assert.doesNotThrow(() => JSON.parse(a['gen_ai.output.messages']));
});

test('a forced replay failure marks the chat span ERROR with error.type InternalServerError', () => {
  const res = run(openaiScript({ fail: true }), { ROASTJUDGE_EXPORTER: 'memory' });
  assert.equal(res.status, 0, res.info);
  const { outcome, chat } = chatSpanOf(res);
  assert.equal(outcome, 'threw:InternalServerError', res.info);
  assert.equal(chat.attributes['error.type'], 'InternalServerError');
  assert.equal(chat.status.code, 2, 'SpanStatusCode.ERROR');
});

test('pub-guide telemetry uses service.name pub-guide (no seat suffix) and seat resource', () => {
  const script = `
const api = require('@opentelemetry/api');
const t = require('./services/pub-guide/telemetry.js');
api.trace.getTracer('test').startSpan('demo').end();
t.sdk.shutdown().catch((e) => { console.error(e); process.exitCode = 1; });
`;
  const res = run(script, { ROASTJUDGE_EXPORTER: 'console', SEAT: '3' }, './services/pub-guide/telemetry.js');
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, DEMO_NAME, res.info);
  assert.match(res.stdout, /['"]?service\.name['"]?\s*:\s*['"]pub-guide['"]/, res.info);
  assert.doesNotMatch(res.stdout, /pub-guide-3/, res.info);
  assert.match(res.stdout, /\bseat['"]?\s*:\s*['"]?3['"]?/, res.info);
});
