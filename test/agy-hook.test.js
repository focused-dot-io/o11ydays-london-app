'use strict';
// telemetry/agy-hook.mjs: the Antigravity CLI hook that turns agy hook payloads into OTLP/JSON spans.
// Content checks on buildRequest (no network): one span per event, one trace per conversation, the
// derived-column fields (tool_name, conversation.id) set, the seat on the resource, and never any
// tool arguments, tool output or prompt text in what is sent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import(path.join(__dirname, '..', 'telemetry', 'agy-hook.mjs'));
const cfg = { OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=k', OTEL_RESOURCE_ATTRIBUTES: 'seat=7' };
const attrs = (list) => Object.fromEntries(list.map((a) => [a.key, Object.values(a.value)[0]]));
const span = (req) => req.resourceSpans[0].scopeSpans[0].spans[0];

test('PostToolUse becomes an agy.tool_result span with tool_name, conversation.id and the seat', async () => {
  const { buildRequest } = await load();
  const req = buildRequest('PostToolUse', {
    conversationId: 'conv-1', modelName: 'gemini-x', stepIdx: 3, invocationNum: 2,
    toolCall: { name: 'run_command', args: { CommandLine: 'cat SECRET_ARG' } },
    result: 'SECRET_OUTPUT',
  }, cfg);
  const s = span(req);
  assert.equal(s.name, 'agy.tool_result');
  const a = attrs(s.attributes);
  assert.equal(a.tool_name, 'run_command');
  assert.equal(a['conversation.id'], 'conv-1');
  assert.equal(a.model, 'gemini-x');
  assert.equal(a['agy.step'], '3');
  assert.equal(a.error, false);
  const res = attrs(req.resourceSpans[0].resource.attributes);
  assert.equal(res['service.name'], 'antigravity-cli');
  assert.equal(res.seat, '7');
  assert.doesNotMatch(JSON.stringify(req), /SECRET_ARG|SECRET_OUTPUT/, 'tool arguments and output are never sent');
});

test('every span of a conversation shares one trace ID; spans are distinct', async () => {
  const { buildRequest } = await load();
  const a = span(buildRequest('PostToolUse', { conversationId: 'c' }, cfg));
  const b = span(buildRequest('Stop', { conversationId: 'c', terminationReason: 'NO_TOOL_CALL' }, cfg));
  const c = span(buildRequest('Stop', { conversationId: 'other' }, cfg));
  assert.equal(a.traceId, b.traceId);
  assert.notEqual(a.traceId, c.traceId);
  assert.notEqual(a.spanId, b.spanId);
  assert.match(a.traceId, /^[0-9a-f]{32}$/);
  assert.match(a.spanId, /^[0-9a-f]{16}$/);
  assert.equal(b.name, 'agy.stop');
  assert.equal(attrs(b.attributes)['agy.termination_reason'], 'NO_TOOL_CALL');
  assert.equal(attrs(b.attributes).tool_name, undefined);
});

test('a failed tool marks the span as an error', async () => {
  const { buildRequest } = await load();
  const s = span(buildRequest('PostToolUse', { conversationId: 'c', toolCall: { name: 'x' }, error: 'exit status 1' }, cfg));
  assert.equal(s.status.code, 2);
  assert.equal(attrs(s.attributes).error, true);
  assert.equal(attrs(s.attributes)['error.message'], 'exit status 1');
});

test('parseEnvFile reads KEY=value lines and skips comments', async () => {
  const { parseEnvFile } = await load();
  assert.deepEqual(parseEnvFile('# c\nA=1\n\nB = "x=y"\n#C=3\n'), { A: '1', B: 'x=y' });
});
