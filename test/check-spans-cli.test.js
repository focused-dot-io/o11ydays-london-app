'use strict';

// Phase 5: scripts/check-spans.cjs, "is Module 2 done?" (always the module-2 set).
//
// SPEC: a diff reporter that FAILs with "missing span `invoke_agent roast-judge`" on 0/1/2, never
// crashes; exit 0 on PASS / 1 on FAIL; `PASS` or `FAIL` is the first word of the last line.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - Same engine as scripts/verify.cjs (same in-process run of judge -> appeal -> final), always the
//    module-2 set, ignoring CHECKPOINT.
//  - First non-empty stdout line is exactly `check-spans: Module 2 trace shape`.
//  - On failure, stdout lists each expected span that is missing as a line containing
//        missing span `<span name>`
//    e.g. missing span `invoke_agent roast-judge`, missing span `chat gpt-4.1-mini`,
//    missing span `execute_tool score_component`. A span that IS present is never listed as missing.
//  - Last line starts with PASS or FAIL; exit 0 / 1; no stack trace on stdout or stderr.
//  - The checkpoint-2 tree is simulated with test/helpers/blank-spans.js (see its contract).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, copyRepo, removeCopy, runNode, hasStackTrace } = require('./helpers/repo-copy.js');
const blank = require('./helpers/blank-spans.js');

const CHECK_SPANS = path.join('scripts', 'check-spans.cjs');
const HEADER = 'check-spans: Module 2 trace shape';

const copies = [];
function copy() {
  const dir = copyRepo();
  copies.push(dir);
  return dir;
}
after(() => copies.forEach(removeCopy));

function assertNoCrash(r) {
  assert.ok(!hasStackTrace(r.stdout), `no stack trace on stdout\n${r.describe()}`);
  assert.ok(!hasStackTrace(r.stderr), `no stack trace on stderr\n${r.describe()}`);
}

test('check-spans: PASS on main', () => {
  const r = runNode(ROOT, CHECK_SPANS);
  assert.equal(r.status, 0, r.describe());
  assert.equal(r.lines[0], HEADER, r.describe());
  assert.ok(r.last.startsWith('PASS'), r.describe());
  assert.doesNotMatch(r.stdout, /missing span/, r.describe());
  assertNoCrash(r);
});

test('check-spans: checkpoint-2 tree (openai line + both span wrappers blank) -> FAIL listing the missing spans', () => {
  const dir = copy();
  blank.blankOpenAI(dir);
  blank.blankAgentSpan(dir);
  blank.blankToolSpan(dir);

  const r = runNode(dir, CHECK_SPANS);
  assert.equal(r.status, 1, r.describe());
  assert.equal(r.lines[0], HEADER, r.describe());
  for (const span of ['invoke_agent roast-judge', 'chat gpt-4.1-mini', 'execute_tool score_component']) {
    assert.ok(r.stdout.includes(`missing span \`${span}\``), `expected "missing span \`${span}\`"\n${r.describe()}`);
  }
  assert.ok(r.last.startsWith('FAIL'), r.describe());
  assertNoCrash(r);

  // Same engine: verify module-2 fails on the same tree.
  const v = runNode(dir, path.join('scripts', 'verify.cjs'), ['module-2']);
  assert.equal(v.status, 1, v.describe());
  assert.ok(v.last.startsWith('FAIL module-2'), v.describe());
  assertNoCrash(v);
});

test('check-spans: only the span wrappers blank (openai on) -> FAIL on invoke_agent, chat not missing', () => {
  const dir = copy();
  blank.blankAgentSpan(dir);
  blank.blankToolSpan(dir);

  const r = runNode(dir, CHECK_SPANS);
  assert.equal(r.status, 1, r.describe());
  assert.ok(r.stdout.includes('missing span `invoke_agent roast-judge`'), r.describe());
  assert.ok(r.stdout.includes('missing span `execute_tool score_component`'), r.describe());
  assert.ok(!r.stdout.includes('missing span `chat'), r.describe());
  assert.ok(r.last.startsWith('FAIL'), r.describe());
  assertNoCrash(r);
});

test('check-spans: ignores CHECKPOINT (always the module-2 set)', () => {
  const dir = copy();
  fs.writeFileSync(path.join(dir, 'CHECKPOINT'), 'checkpoint-0\n');
  const r = runNode(dir, CHECK_SPANS);
  assert.equal(r.status, 0, r.describe());
  assert.ok(r.last.startsWith('PASS'), r.describe());
});

test('check-spans: unique but incorrect tool-call IDs fail model correlation', () => {
  const dir = copy();
  const file = path.join(dir, 'src', 'agent.js');
  const original = fs.readFileSync(file, 'utf8');
  // item.id (fc_...) is the realistic slip: the response item carries both it and call_id (call_...).
  const wrong = original.replace("'gen_ai.tool.call.id': item.call_id", "'gen_ai.tool.call.id': item.id");
  assert.notEqual(wrong, original, 'the deliberate fault must be applied');
  fs.writeFileSync(file, wrong);
  const r = runNode(dir, CHECK_SPANS);
  assert.equal(r.status, 1, r.describe());
  assert.match(r.stdout, /does not match a model tool call/, r.describe());
  assertNoCrash(r);
});
