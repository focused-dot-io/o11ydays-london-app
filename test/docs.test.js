'use strict';
// Phase 9: documentation, track cards, coding-agent telemetry templates and the Act 1 task.
// These are content checks: the files exist, say the things the modules depend on, and the
// templates leave exactly two blanks (<SEAT> and <KEY>) and never ship prompt content on.
//
// ASSUMPTIONS (the implementer follows these):
//  - Template blanks are the literal tokens `<SEAT>` and `<KEY>`; nothing else is a placeholder.
//  - Templates send to https://api.honeycomb.io, carry OTEL_RESOURCE_ATTRIBUTES=seat=<SEAT>,
//    route metrics to the `agent-metrics` dataset via x-honeycomb-dataset (agents that have metrics),
//    and keep prompt content off.
//  - telemetry/README.md defines the four Module 1 derived columns with COALESCE.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const DOCS = [
  'README.md',
  'docs/old-names.md',
  'docs/checkpoints.md',
  'tracks/a-content-capture.md',
  'tracks/b-cost-and-slo.md',
  'tracks/c-agent-timeline.md',
  'tasks/act1.md',
  'tasks/module3.md',
  'telemetry/README.md',
];
const TEMPLATES = [
  'telemetry/claude-settings.local.json',
  'telemetry/agy.env',
  'telemetry/codex-config.toml',
  'telemetry/envrc',
];

test('every doc, track card, task and template file exists and is non-trivial', () => {
  for (const f of [...DOCS, ...TEMPLATES]) {
    assert.ok(exists(f), `missing ${f}`);
    assert.ok(read(f).trim().length > 40, `${f} is too short to be real`);
  }
});

test('README covers setup, lanes, commands, catch-up and the default-branch note', () => {
  const readme = read('README.md');
  for (const needle of [
    'verify-setup.sh',
    'npm run setup',
    'npm run first-trace',
    'npm run dev',
    'docker compose up',
    'npm run catchup',
    'npm run check-spans',
    'npm run verify',
    'npm run prompt',
    'npm run load',
    'checkpoint-0',
    'default branch',
    'Codespace',
    'roast-judge-<seat>',
    'ui.honeycomb.io',
    'telemetry/',
    'tracks/',
  ]) {
    assert.ok(readme.includes(needle), `README.md should mention ${JSON.stringify(needle)}`);
  }
  assert.doesNotMatch(readme, /Setup instructions follow in the build PR/, 'README is still the stub');
});

test('docs/old-names.md lists the legacy attribute names attendees will meet', () => {
  const doc = read('docs/old-names.md');
  for (const needle of ['gen_ai.system', 'gen_ai.usage.prompt_tokens', 'ai.generateText', 'llm.', 'gen_ai.provider.name', 'gen_ai.usage.input_tokens']) {
    assert.ok(doc.includes(needle), `old-names.md should mention ${needle}`);
  }
});

test('track cards name the flag, attributes and queries that prove each track', () => {
  const a = read('tracks/a-content-capture.md');
  for (const needle of ['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'gen_ai.input.messages', 'gen_ai.output.messages', 'Opt-In']) {
    assert.ok(a.includes(needle), `track a should mention ${needle}`);
  }
  const b = read('tracks/b-cost-and-slo.md');
  for (const needle of ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'derived column', 'roastjudge.components_scored', 'gen_ai.prompt.version']) {
    assert.ok(b.includes(needle), `track b should mention ${needle}`);
  }
  assert.match(b, /SLO|trigger/i);
  const c = read('tracks/c-agent-timeline.md');
  for (const needle of ['gen_ai.conversation.id', 'gen_ai.agent.name', '/appeal', '/final', 'Agent Timeline', 'TODO(module-4c)']) {
    assert.ok(c.includes(needle), `track c should mention ${needle}`);
  }
});

test('tasks/act1.md is a scripted task with a read, an edit, a shell command and a test run', () => {
  const t = read('tasks/act1.md');
  assert.match(t, /read/i);
  assert.match(t, /edit|change|modify/i);
  assert.match(t, /npm test|node --test/);
  assert.match(t, /bash|shell|terminal|run/i);
  assert.ok(t.includes('replay/corpus.json') || t.includes('services/') || t.includes('src/'), 'task should point at real files in this repo');
});

test('telemetry/README.md defines the four Module 1 derived columns', () => {
  const r = read('telemetry/README.md');
  for (const col of ['agent.input_tokens', 'agent.output_tokens', 'agent.tool', 'agent.session']) {
    assert.ok(r.includes(col), `telemetry README should define ${col}`);
  }
  assert.match(r, /COALESCE/);
  for (const field of ['input_tokens', 'input_token_count', 'tool_name', 'session.id', 'conversation.id', 'user.email']) {
    assert.ok(r.includes(field), `telemetry README should mention ${field}`);
  }
  assert.match(r, /agent-metrics/);
});

test('templates: US endpoint, seat resource attribute, agent-metrics dataset, only <SEAT> and <KEY> blanks', () => {
  for (const f of TEMPLATES) {
    const t = read(f);
    assert.ok(t.includes('api.honeycomb.io'), `${f} must point at the US endpoint`);
    assert.ok(t.includes('<KEY>'), `${f} must have the <KEY> blank`);
    assert.ok(t.includes('<SEAT>'), `${f} must have the <SEAT> blank`);
    const otherBlanks = (t.match(/<[A-Z_]+>/g) || []).filter((m) => m !== '<SEAT>' && m !== '<KEY>');
    assert.deepEqual(otherBlanks, [], `${f} has blanks other than <SEAT>/<KEY>: ${otherBlanks.join(', ')}`);
    assert.ok(/seat=<SEAT>/.test(t), `${f} must set OTEL_RESOURCE_ATTRIBUTES=seat=<SEAT>`);
    assert.doesNotMatch(t, /hcaik_[A-Za-z0-9]{6,}|sk-[A-Za-z0-9]{20,}/, `${f} looks like it leaks a real key`);
  }
  // Metrics dataset header on every template that configures metrics.
  for (const f of ['telemetry/claude-settings.local.json', 'telemetry/codex-config.toml']) {
    assert.ok(read(f).includes('x-honeycomb-dataset=agent-metrics') || read(f).includes('"x-honeycomb-dataset" = "agent-metrics"'),
      `${f} must route metrics to agent-metrics`);
  }
});

test('Claude Code template is valid JSON with the env block the module describes', () => {
  const j = JSON.parse(read('telemetry/claude-settings.local.json'));
  assert.equal(typeof j.env, 'object');
  assert.equal(j.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(j.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://api.honeycomb.io');
  assert.equal(j.env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/protobuf');
  assert.match(j.env.OTEL_EXPORTER_OTLP_HEADERS, /x-honeycomb-team=<KEY>/);
  assert.match(j.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS, /x-honeycomb-dataset=agent-metrics/);
  assert.equal(j.env.OTEL_RESOURCE_ATTRIBUTES, 'seat=<SEAT>');
  assert.equal(j.env.OTEL_METRICS_EXPORTER, 'otlp');
  assert.equal(j.env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(j.env.OTEL_METRIC_EXPORT_INTERVAL, '10000');
  assert.notEqual(j.env.OTEL_LOG_USER_PROMPTS, '1', 'prompt content must stay off');
});

test('Antigravity hooks template runs the repo hook on passive events only; agy.env carries key and seat', () => {
  const j = JSON.parse(read('telemetry/agy-hooks.json'));
  const groups = Object.values(j);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.enabled, true);
  const events = Object.keys(g).filter((k) => k !== 'enabled').sort();
  assert.deepEqual(events, ['PostInvocation', 'PostToolUse', 'Stop'], 'no PreToolUse: a telemetry hook must not gate tools');
  const commands = JSON.stringify(g).match(/"command":"[^"]+"/g);
  assert.equal(commands.length, 3);
  for (const c of commands) assert.match(c, /node \.\.\/telemetry\/agy-hook\.mjs (PostToolUse|PostInvocation|Stop)"/);
  assert.ok(exists('telemetry/agy-hook.mjs'));
  const env = read('telemetry/agy.env');
  assert.match(env, /^OTEL_EXPORTER_OTLP_ENDPOINT=https:\/\/api\.honeycomb\.io$/m);
  assert.match(env, /^OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<KEY>$/m);
  assert.match(env, /^OTEL_RESOURCE_ATTRIBUTES=seat=<SEAT>$/m);
});

test('Codex template has an [otel] block with prompts off and a non-statsig metrics exporter; envrc sets CODEX_HOME', () => {
  const toml = read('telemetry/codex-config.toml');
  assert.match(toml, /^\[otel\]/m);
  assert.match(toml, /log_user_prompt\s*=\s*false/);
  assert.match(toml, /x-honeycomb-team/);
  assert.ok(!/metrics_exporter\s*=\s*"statsig"/.test(toml), 'metrics must not go to statsig');
  assert.match(toml, /metrics_exporter|metrics/);
  const envrc = read('telemetry/envrc');
  assert.match(envrc, /export CODEX_HOME=.*\.codex-home/);
});
