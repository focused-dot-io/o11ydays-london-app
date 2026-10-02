#!/usr/bin/env node
'use strict';

// `npm run check-spans`: is Module 2 done? Always runs the module-2 expectation set (whatever
// CHECKPOINT says) and lists every Module 2 span missing from the judge trace.

const { main } = require('./lib/run-checks.cjs');

const MODULE_2_SPANS = [
  'invoke_agent roast-judge',
  'chat gpt-4.1-mini',
  'execute_tool score_component',
  'execute_tool lookup_pub',
  'execute_tool compare_to_benchmarks',
];

function hint(missing) {
  const lines = [];
  if (missing.includes('chat gpt-4.1-mini')) {
    lines.push('hint: no chat spans. Module 2 Bite 1: add `new OpenAIInstrumentation()` to the instrumentations in src/telemetry.js.');
  }
  if (missing.includes('invoke_agent roast-judge')) {
    lines.push('hint: no invoke_agent span. Module 2 Bite 1: fill in withAgentSpan() in src/agent.js (TODO(module-2)).');
  }
  if (missing.some((n) => n.startsWith('execute_tool '))) {
    lines.push('hint: no execute_tool spans. Module 2 Bite 2: fill in withToolSpan() in src/agent.js (TODO(module-2)).');
  }
  return lines;
}

main({
  set: 'module-2',
  header: 'check-spans: Module 2 trace shape',
  expectedSpans: MODULE_2_SPANS,
  hint,
});
