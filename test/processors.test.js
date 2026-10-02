'use strict';

// Phase 3: src/telemetry/processors.js (pure; no side effects on require).
//
// ASSUMPTIONS beyond SPEC.md (the implementer must follow these):
// - `new InheritAttributesSpanProcessor({ replayUrl })`. `replayUrl` is optional; when omitted the
//   processor reads `process.env.REPLAY_URL || 'http://localhost:4200/v1'` lazily at each onStart
//   (src/telemetry.js is loaded via --require, before the app may set REPLAY_URL).
// - Inheritance happens in onStart only: attributes set on the parent AFTER the child started are
//   NOT inherited (known limitation; the agent sets prompt attrs in startActiveSpan options or
//   before the first chat call).
// - `roastjudge.model.replay` is set only on spans with `gen_ai.operation.name` AND `server.address`;
//   value is `isReplayAddress(server.address, server.port, replayUrl)`.
// - `isReplayAddress(address, port, replayUrl)`: hostnames compare case-insensitively and
//   `localhost`, `127.0.0.1`, `::1` (and `[::1]`) are treated as the same host; ports compare as
//   numbers (string or number accepted); when the URL has no explicit port the scheme default
//   applies (http 80, https 443); when `port` is undefined/null only the host is compared.
// - `new ContentToSpanLogProcessor()` takes no required args and copies unconditionally; gating on
//   OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT is src/telemetry.js's job (see
//   telemetry-bootstrap.test.js). Non-string values are JSON.stringify'd; strings are copied as-is.
// - sdk-logs 0.222.0 `LoggerProvider` constructor takes `{ processors: LogRecordProcessor[] }`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { context, trace, SpanKind } = require('@opentelemetry/api');
const {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');
const { LoggerProvider } = require('@opentelemetry/sdk-logs');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');

// context.with() needs a real context manager; this file runs in its own process under node:test.
// The tracer provider itself is NOT registered globally.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const PROCESSORS = path.join(__dirname, '..', 'src', 'telemetry', 'processors.js');
const REPLAY_URL = 'http://localhost:4200/v1';
const INHERITED = [
  'gen_ai.prompt.name',
  'gen_ai.prompt.version',
  'gen_ai.conversation.id',
  'gen_ai.agent.name',
];

function load() {
  return require(PROCESSORS);
}

function setup() {
  const { InheritAttributesSpanProcessor } = load();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new InheritAttributesSpanProcessor({ replayUrl: REPLAY_URL }),
      new SimpleSpanProcessor(exporter),
    ],
  });
  const tracer = provider.getTracer('t');
  const byName = (name) => {
    const found = exporter.getFinishedSpans().filter((s) => s.name === name);
    assert.equal(found.length, 1, `expected exactly one finished span named ${name}`);
    return found[0];
  };
  return { tracer, exporter, provider, byName };
}

// A context whose active span is `span`.
function under(span) {
  return trace.setSpan(context.active(), span);
}

const ROOT_ATTRS = {
  'gen_ai.operation.name': 'invoke_agent',
  'gen_ai.agent.name': 'roast-judge',
  'gen_ai.prompt.name': 'roast-judge',
  'gen_ai.prompt.version': 'v1',
  'gen_ai.conversation.id': 'c1',
};

test('processors module exports the fixed interface', () => {
  const mod = load();
  assert.equal(typeof mod.InheritAttributesSpanProcessor, 'function');
  assert.equal(typeof mod.ContentToSpanLogProcessor, 'function');
  assert.equal(typeof mod.isReplayAddress, 'function');
});

test('INHERITED_KEYS is exactly the four gen_ai keys', () => {
  assert.deepEqual(load().INHERITED_KEYS, INHERITED);
});

test('InheritAttributesSpanProcessor propagates the four keys three levels deep and flags replay', async () => {
  const { tracer, byName, provider } = setup();
  const root = tracer.startSpan('invoke_agent roast-judge', { kind: SpanKind.INTERNAL, attributes: ROOT_ATTRS });
  const rootCtx = under(root);
  const chat = tracer.startSpan(
    'chat gpt-4.1-mini',
    {
      kind: SpanKind.CLIENT,
      attributes: { 'gen_ai.operation.name': 'chat', 'server.address': 'localhost', 'server.port': 4200 },
    },
    rootCtx,
  );
  const tool = tracer.startSpan(
    'execute_tool lookup_pub',
    { kind: SpanKind.INTERNAL, attributes: { 'gen_ai.operation.name': 'execute_tool' } },
    under(chat),
  );
  tool.end();
  chat.end();
  root.end();
  await provider.forceFlush();

  const rootSpan = byName('invoke_agent roast-judge');
  for (const name of ['chat gpt-4.1-mini', 'execute_tool lookup_pub']) {
    const s = byName(name);
    for (const k of INHERITED) {
      assert.equal(s.attributes[k], rootSpan.attributes[k], `${name} should inherit ${k}`);
      assert.notEqual(s.attributes[k], undefined, `${name} should have ${k}`);
    }
  }
  assert.equal(byName('chat gpt-4.1-mini').attributes['roastjudge.model.replay'], true);
  // execute_tool has no server.address, so no replay flag
  assert.equal(byName('execute_tool lookup_pub').attributes['roastjudge.model.replay'], undefined);
});

test('InheritAttributesSpanProcessor never overrides a key the child already has', () => {
  const { tracer, byName } = setup();
  const root = tracer.startSpan('invoke_agent roast-judge', { attributes: ROOT_ATTRS });
  const child = tracer.startSpan(
    'chat gpt-4.1-mini',
    { attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.prompt.version': 'v2' } },
    under(root),
  );
  child.end();
  root.end();
  const s = byName('chat gpt-4.1-mini');
  assert.equal(s.attributes['gen_ai.prompt.version'], 'v2');
  assert.equal(s.attributes['gen_ai.prompt.name'], 'roast-judge', 'absent keys are still filled');
});

test('InheritAttributesSpanProcessor skips children without gen_ai.operation.name', () => {
  const { tracer, byName } = setup();
  const root = tracer.startSpan('invoke_agent roast-judge', { attributes: ROOT_ATTRS });
  const child = tracer.startSpan(
    'GET /pubs/x',
    { kind: SpanKind.CLIENT, attributes: { 'server.address': 'localhost', 'server.port': 4200, 'http.request.method': 'GET' } },
    under(root),
  );
  child.end();
  root.end();
  const s = byName('GET /pubs/x');
  for (const k of INHERITED) assert.equal(s.attributes[k], undefined, `non-gen_ai span must not get ${k}`);
  assert.equal(s.attributes['roastjudge.model.replay'], undefined);
});

test('known limitation: parent attributes set after the child started are not inherited', () => {
  const { tracer, byName } = setup();
  const root = tracer.startSpan('invoke_agent roast-judge', {
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'roast-judge' },
  });
  const child = tracer.startSpan('chat gpt-4.1-mini', { attributes: { 'gen_ai.operation.name': 'chat' } }, under(root));
  // Too late: the agent must set these in startActiveSpan options or before the first chat call.
  root.setAttribute('gen_ai.prompt.version', 'v1');
  root.setAttribute('gen_ai.prompt.name', 'roast-judge');
  child.end();
  root.end();
  const s = byName('chat gpt-4.1-mini');
  assert.equal(s.attributes['gen_ai.agent.name'], 'roast-judge', 'attrs present at child start are inherited');
  assert.equal(s.attributes['gen_ai.prompt.version'], undefined);
  assert.equal(s.attributes['gen_ai.prompt.name'], undefined);
});

test('isReplayAddress matches host/port against the replay URL (localhost == 127.0.0.1 == ::1)', () => {
  const { isReplayAddress } = load();
  assert.equal(isReplayAddress('localhost', 4200, REPLAY_URL), true);
  assert.equal(isReplayAddress('127.0.0.1', 4200, REPLAY_URL), true);
  assert.equal(isReplayAddress('::1', 4200, REPLAY_URL), true);
  assert.equal(isReplayAddress('localhost', '4200', REPLAY_URL), true, 'string port accepted');
  assert.equal(isReplayAddress('localhost', 4300, REPLAY_URL), false, 'port must match');
  assert.equal(isReplayAddress('api.openai.com', 443, REPLAY_URL), false);
  assert.equal(isReplayAddress('replay', 4200, 'http://replay:4200/v1'), true, 'docker compose hostname');
  assert.equal(isReplayAddress('replay', 80, 'http://replay/v1'), true, 'scheme default port');
});

test('roastjudge.model.replay is false for a real provider and absent without server.address', () => {
  const { tracer, byName } = setup();
  const live = tracer.startSpan('chat gpt-4.1-mini', {
    attributes: { 'gen_ai.operation.name': 'chat', 'server.address': 'api.openai.com', 'server.port': 443 },
  });
  live.end();
  const noAddr = tracer.startSpan('chat other', { attributes: { 'gen_ai.operation.name': 'chat' } });
  noAddr.end();
  assert.equal(byName('chat gpt-4.1-mini').attributes['roastjudge.model.replay'], false);
  assert.equal(byName('chat other').attributes['roastjudge.model.replay'], undefined);
});

test('a root gen_ai span with no parent does not throw and inherits nothing', () => {
  const { tracer, byName } = setup();
  const root = tracer.startSpan('invoke_agent roast-judge', {
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'roast-judge' },
  });
  root.end();
  const s = byName('invoke_agent roast-judge');
  assert.equal(s.attributes['gen_ai.agent.name'], 'roast-judge');
  for (const k of INHERITED.filter((k) => k !== 'gen_ai.agent.name')) assert.equal(s.attributes[k], undefined);
});

// ---- ContentToSpanLogProcessor ----

function logSetup() {
  const { ContentToSpanLogProcessor } = load();
  const traces = setup();
  const loggerProvider = new LoggerProvider({ processors: [new ContentToSpanLogProcessor()] });
  const logger = loggerProvider.getLogger('t');
  return { ...traces, logger, loggerProvider };
}

const INPUT = [{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }];
const OUTPUT = [
  { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'lookup_pub', arguments: '{"slug":"x"}' }], finish_reason: 'tool_call' },
];

test('ContentToSpanLogProcessor copies input/output messages onto the active chat span as JSON', () => {
  const { tracer, byName, logger } = logSetup();
  const chat = tracer.startSpan('chat gpt-4.1-mini', { attributes: { 'gen_ai.operation.name': 'chat' } });
  context.with(under(chat), () => {
    logger.emit({ attributes: { 'gen_ai.provider.name': 'openai', 'gen_ai.input.messages': INPUT } });
    logger.emit({ attributes: { 'gen_ai.provider.name': 'openai', 'gen_ai.output.messages': OUTPUT } });
  });
  chat.end();
  const s = byName('chat gpt-4.1-mini');
  assert.equal(typeof s.attributes['gen_ai.input.messages'], 'string');
  assert.equal(typeof s.attributes['gen_ai.output.messages'], 'string');
  assert.deepEqual(JSON.parse(s.attributes['gen_ai.input.messages']), INPUT);
  assert.deepEqual(JSON.parse(s.attributes['gen_ai.output.messages']), OUTPUT);
});

test('ContentToSpanLogProcessor uses the context passed to emit (as instrumentation-openai does)', () => {
  const { tracer, byName, logger } = logSetup();
  const chat = tracer.startSpan('chat gpt-4.1-mini', { attributes: { 'gen_ai.operation.name': 'chat' } });
  logger.emit({ context: under(chat), attributes: { 'gen_ai.input.messages': INPUT } });
  chat.end();
  assert.deepEqual(JSON.parse(byName('chat gpt-4.1-mini').attributes['gen_ai.input.messages']), INPUT);
});

test('ContentToSpanLogProcessor leaves the span untouched for records without message attributes', () => {
  const { tracer, byName, logger } = logSetup();
  const chat = tracer.startSpan('chat gpt-4.1-mini', { attributes: { 'gen_ai.operation.name': 'chat' } });
  context.with(under(chat), () => {
    logger.emit({ body: 'something else', attributes: { 'gen_ai.provider.name': 'openai', foo: 'bar' } });
  });
  chat.end();
  const s = byName('chat gpt-4.1-mini');
  assert.equal(s.attributes['gen_ai.input.messages'], undefined);
  assert.equal(s.attributes['gen_ai.output.messages'], undefined);
  assert.equal(s.attributes.foo, undefined);
  assert.equal(s.attributes['gen_ai.provider.name'], undefined);
});

test('ContentToSpanLogProcessor does not throw when there is no active span', () => {
  const { logger } = logSetup();
  assert.doesNotThrow(() => logger.emit({ attributes: { 'gen_ai.input.messages': INPUT } }));
});

test('ContentToSpanLogProcessor copies an already-string message attribute as-is', () => {
  const { tracer, byName, logger } = logSetup();
  const chat = tracer.startSpan('chat gpt-4.1-mini', { attributes: { 'gen_ai.operation.name': 'chat' } });
  const raw = '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]';
  context.with(under(chat), () => {
    logger.emit({ attributes: { 'gen_ai.input.messages': raw } });
  });
  chat.end();
  assert.equal(byName('chat gpt-4.1-mini').attributes['gen_ai.input.messages'], raw);
});

test('ContentToSpanLogProcessor has shutdown/forceFlush that resolve', async () => {
  const { ContentToSpanLogProcessor } = load();
  const p = new ContentToSpanLogProcessor();
  await p.forceFlush();
  await p.shutdown();
});
