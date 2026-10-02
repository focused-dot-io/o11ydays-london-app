'use strict';

// Phase 5: scripts/verify.cjs, the CLI that says "this checkpoint is healthy as shipped".
//
// SPEC: reads CHECKPOINT and runs scripts/expectations/<name>.js against an in-memory exporter, with
// pub-guide and replay forked as children on ephemeral ports. Exit 0 on PASS / 1 on FAIL, `PASS` or
// `FAIL` is the first word of the last line, never throws.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - `node scripts/verify.cjs [name]`: the set is argv[2] when given, else the trimmed contents of
//    CHECKPOINT at the repo root (resolved relative to the script, not the cwd).
//  - It sets process.env.ROASTJUDGE_EXPORTER = 'memory' and requires src/telemetry.js FIRST, forks
//    services/pub-guide/server.js and services/model-replay/server.js (REPLAY_LATENCY_SCALE=0,
//    REPLAY_FAIL_EVERY=0) on ephemeral ports, sets REPLAY_URL / PUB_GUIDE_URL, serves createApp()
//    in-process on an ephemeral port, then POSTs judge -> appeal -> final (header
//    x-roastjudge-model: replay), force-flushes, groups the spans by trace id into
//    ctx = { checkpoint, turns: [{ name:'judge', spans }, { name:'appeal', spans }, { name:'final', spans }] }
//    and runs the set. It kills its children on every exit path.
//  - Output (stdout), one line per check in set order:
//        ok <check name>
//        FAIL <check name>: <reason>
//    then the last line:
//        PASS <set>: <N> checks
//        FAIL <set>: <K> of <N> checks failed
//    Any crash (unknown set, server failed to start, a check threw...) prints
//        FAIL <set>: <error message>
//    as the last line and exits 1, with no stack trace on stdout or stderr.
//  - The repo root carries a CHECKPOINT file containing exactly `main\n`.
//  - Blanked trees (see test/helpers/blank-spans.js) stand in for checkpoint overlays here:
//    all three blanks = checkpoint-0/1/2 shape; withToolSpan blank only = checkpoint-2-cut shape;
//    conversation.id line deleted = checkpoint-3/4 shape.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, copyRepo, removeCopy, runNode, hasStackTrace } = require('./helpers/repo-copy.js');
const blank = require('./helpers/blank-spans.js');

const VERIFY = path.join('scripts', 'verify.cjs');
const verify = (cwd, ...args) => runNode(cwd, VERIFY, args);

const copies = [];
function copy() {
  const dir = copyRepo();
  copies.push(dir);
  return dir;
}
after(() => copies.forEach(removeCopy));

function setSize(name) {
  return require(path.join(ROOT, 'scripts', 'expectations', `${name}.js`)).length;
}

function assertPass(r, name) {
  assert.equal(r.status, 0, r.describe());
  const m = /^PASS (\S+): (\d+) checks$/.exec(r.last);
  assert.ok(m, `last line is not "PASS ${name}: N checks"\n${r.describe()}`);
  assert.equal(m[1], name, r.describe());
  assert.equal(Number(m[2]), setSize(name), r.describe());
  const oks = r.lines.filter((l) => l.startsWith('ok '));
  assert.equal(oks.length, setSize(name), `one "ok <name>" line per check\n${r.describe()}`);
  assert.ok(!r.lines.some((l) => l.startsWith('FAIL')), r.describe());
}

function assertFail(r, name) {
  assert.equal(r.status, 1, r.describe());
  assert.ok(r.last.startsWith(`FAIL ${name}`), `last line starts "FAIL ${name}"\n${r.describe()}`);
  assert.ok(!hasStackTrace(r.stdout), `no stack trace on stdout\n${r.describe()}`);
  assert.ok(!hasStackTrace(r.stderr), `no stack trace on stderr\n${r.describe()}`);
}

test('CHECKPOINT at the repo root is "main"', () => {
  const p = path.join(ROOT, 'CHECKPOINT');
  assert.ok(fs.existsSync(p), 'CHECKPOINT exists');
  assert.equal(fs.readFileSync(p, 'utf8'), 'main\n');
});

test('verify: no argument reads CHECKPOINT and PASSes main on main', () => {
  assertPass(verify(ROOT), 'main');
});

test('verify module-2: PASS on main', () => {
  assertPass(verify(ROOT, 'module-2'), 'module-2');
});

test('verify checkpoint-3: PASS on main (it says nothing about conversation.id)', () => {
  assertPass(verify(ROOT, 'checkpoint-3'), 'checkpoint-3');
});

test('verify checkpoint-4: FAIL on main, naming the conversation.id check only', () => {
  const r = verify(ROOT, 'checkpoint-4');
  assertFail(r, 'checkpoint-4');
  assert.match(r.last, new RegExp(`^FAIL checkpoint-4: 1 of ${setSize('checkpoint-4')} checks failed$`), r.describe());
  const fails = r.lines.slice(0, -1).filter((l) => l.startsWith('FAIL '));
  assert.equal(fails.length, 1, r.describe());
  assert.match(fails[0], /conversation\.id/);
  assert.equal(r.lines.filter((l) => l.startsWith('ok ')).length, setSize('checkpoint-4') - 1, r.describe());
});

test('verify checkpoint-0: FAIL on main (gen_ai spans present)', () => {
  const r = verify(ROOT, 'checkpoint-0');
  assertFail(r, 'checkpoint-0');
  assert.match(r.last, /^FAIL checkpoint-0: \d+ of \d+ checks failed$/, r.describe());
});

test('verify no-such-set: FAIL naming the set, exit 1, never crashes', () => {
  const r = verify(ROOT, 'no-such-set');
  assertFail(r, 'no-such-set');
});

test('verify: CHECKPOINT=checkpoint-0 in a copy of main -> FAIL checkpoint-0; blanked tree -> PASS 0/1/2', () => {
  const dir = copy();
  fs.writeFileSync(path.join(dir, 'CHECKPOINT'), 'checkpoint-0\n');
  assertFail(verify(dir), 'checkpoint-0');

  blank.blankOpenAI(dir);
  blank.blankAgentSpan(dir);
  blank.blankToolSpan(dir);
  assertPass(verify(dir), 'checkpoint-0');
  assertPass(verify(dir, 'checkpoint-1'), 'checkpoint-1');
  assertPass(verify(dir, 'checkpoint-2'), 'checkpoint-2');
  assertFail(verify(dir, 'module-2'), 'module-2');
  assertFail(verify(dir, 'checkpoint-2-cut'), 'checkpoint-2-cut');
});

test('verify checkpoint-2-cut: PASS on a tree with only withToolSpan blanked; main FAILs there', () => {
  const dir = copy();
  blank.blankToolSpan(dir);
  assertPass(verify(dir, 'checkpoint-2-cut'), 'checkpoint-2-cut');
  assertFail(verify(dir, 'main'), 'main');
  assertFail(verify(dir, 'module-2'), 'module-2');
});

test('verify checkpoint-4: PASS on a tree without gen_ai.conversation.id; 3 PASS, main FAILs', () => {
  const dir = copy();
  blank.blankConversationId(dir);
  assertPass(verify(dir, 'checkpoint-4'), 'checkpoint-4');
  assertPass(verify(dir, 'checkpoint-3'), 'checkpoint-3');
  const r = verify(dir, 'main');
  assertFail(r, 'main');
  assert.match(r.stdout, /conversation\.id/, r.describe());
});
