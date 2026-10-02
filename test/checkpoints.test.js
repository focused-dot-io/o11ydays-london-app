'use strict';

// Phase 7: the checkpoint overlays in checkpoints/<name>/.
//
// SPEC: branches are generated from main by copying checkpoints/<name>/ overlay files over the tree
// (overlays: src/agent.js, src/telemetry.js, CHECKPOINT). "A test applies each overlay into a temp
// dir and asserts the diff against main touches only hunks containing `TODO(module-`, plus runs
// each checkpoint's verify set." check-spans PASSes on 3/4 and FAILs readably on 0/1/2.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - Overlay file set: an overlay holds CHECKPOINT (exactly `<name>\n`) plus ONLY the files that
//    differ from main. 0, 1, 2 -> CHECKPOINT, src/agent.js, src/telemetry.js. 2-cut, 3, 4 ->
//    CHECKPOINT, src/agent.js (their telemetry.js equals main's, so it is omitted). Nothing else.
//  - checkpoint-0 and checkpoint-1 overlay files are byte-identical to checkpoint-2's (apart from
//    CHECKPOINT); checkpoint-3's src/agent.js is byte-identical to checkpoint-4's.
//  - The hunk rule: `git diff --no-index -U3 <main file> <overlay file>` is non-empty and EVERY hunk
//    has `TODO(module-` (any module: 2, 3, 4c...) on at least one of its changed (+/-) lines.
//    Consequence: everything outside the TODO blocks (e.g. the `require` of OpenAIInstrumentation
//    in telemetry.js) stays exactly as on main. main's src/agent.js and src/telemetry.js contain
//    no `TODO(module-` at all.
//  - No verbatim answer: in every hunk that removes code, at least one removed line (trimmed, with
//    any leading `//` stripped) does not appear among the hunk's added lines (likewise normalised).
//  - telemetry.js on 0/1/2: the `new OpenAIInstrumentation(), // Module 2: the one-liner` line is
//    replaced, in the same place, by a line containing
//    `// TODO(module-2): enable the openai instrumentation here`; no code line constructs
//    `new OpenAIInstrumentation(`.
//  - agent.js on 0/1/2: `withAgentSpan` and `withToolSpan` are pass-throughs: the only code line of
//    each body is `return run();` and each body contains `TODO(module-2)`. The TODO blocks (the
//    TODO line plus the contiguous `//` lines below it) are the attendee hint: across the file they
//    mention `invoke_agent` and `execute_tool` (span name, kind, attributes).
//  - agent.js on 2-cut: withAgentSpan builds the `invoke_agent` span with `gen_ai.operation.name` and
//    `gen_ai.agent.name` only; `// TODO(module-3)` comment lines stand where the prompt attrs and the
//    verdict attrs go, `// TODO(module-4c)` where gen_ai.conversation.id goes; withToolSpan is a
//    pass-through with `TODO(module-2)`.
//  - agent.js on 3/4: main's, with the `'gen_ai.conversation.id': conversation.id,` line replaced by
//    `// TODO(module-4c): stamp gen_ai.conversation.id here (track c)`.
//  - Behaviour: with the overlay copied over a copy of the repo, `node scripts/verify.cjs` (no
//    argument, so it reads the overlay's CHECKPOINT) PASSes; check-spans exits 1 on 0/1/2/2-cut and
//    0 on 3/4.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { copyRepo, removeCopy } = require('./helpers/repo-copy.js');
const { runNode } = require('./helpers/run-script.js');
const ov = require('./helpers/checkpoint-overlays.js');

const { ROOT, NAMES, EXPECTED_FILES } = ov;
const FAILS_CHECK_SPANS = new Set(['checkpoint-0', 'checkpoint-1', 'checkpoint-2', 'checkpoint-2-cut']);
const TELEMETRY_TODO = '// TODO(module-2): enable the openai instrumentation here';
const CONV_TODO = '// TODO(module-4c): stamp gen_ai.conversation.id here (track c)';

const exists = (name) => fs.existsSync(ov.overlayDir(name));
const hasFile = (name, rel) => fs.existsSync(path.join(ov.overlayDir(name), rel));
const mainSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function requireOverlay(name, rel) {
  assert.ok(exists(name), `checkpoints/${name}/ exists`);
  if (rel) assert.ok(hasFile(name, rel), `checkpoints/${name}/${rel} exists`);
}

const setSize = (name) => require(path.join(ROOT, 'scripts', 'expectations', `${name}.js`)).length;

function summarise(r) {
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  return { ...r, lines, last: lines.length ? lines[lines.length - 1] : '' };
}

// ---------------------------------------------------------------------------------------------
// Static checks

test('checkpoints/: exactly the six overlay directories (main has none)', () => {
  assert.ok(fs.existsSync(ov.CHECKPOINTS_DIR), 'checkpoints/ exists');
  const dirs = fs
    .readdirSync(ov.CHECKPOINTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(dirs, [...NAMES].sort());
  assert.ok(!exists('main'), 'no checkpoints/main/');
});

for (const name of NAMES) {
  test(`${name}: overlay holds exactly ${EXPECTED_FILES[name].join(', ')}; CHECKPOINT is "${name}\\n"`, () => {
    requireOverlay(name);
    assert.deepEqual(ov.listOverlayFiles(name), [...EXPECTED_FILES[name]].sort());
    assert.equal(ov.readOverlay(name, 'CHECKPOINT'), `${name}\n`);
  });
}

test('checkpoint-0 and checkpoint-1 overlay files are byte-identical to checkpoint-2 (except CHECKPOINT)', () => {
  for (const name of ['checkpoint-0', 'checkpoint-1']) {
    for (const rel of ['src/agent.js', 'src/telemetry.js']) {
      requireOverlay(name, rel);
      requireOverlay('checkpoint-2', rel);
      assert.ok(
        fs.readFileSync(path.join(ov.overlayDir(name), rel)).equals(fs.readFileSync(path.join(ov.overlayDir('checkpoint-2'), rel))),
        `${name}/${rel} equals checkpoint-2/${rel}`,
      );
    }
  }
});

test('checkpoint-3 and checkpoint-4 ship identical src/agent.js', () => {
  requireOverlay('checkpoint-3', 'src/agent.js');
  requireOverlay('checkpoint-4', 'src/agent.js');
  assert.ok(
    fs.readFileSync(path.join(ov.overlayDir('checkpoint-3'), 'src/agent.js')).equals(
      fs.readFileSync(path.join(ov.overlayDir('checkpoint-4'), 'src/agent.js')),
    ),
  );
});

test('every overlay .js file parses (node --check)', () => {
  let checked = 0;
  for (const name of NAMES) {
    requireOverlay(name);
    for (const rel of ov.listOverlayFiles(name).filter((f) => f.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--check', path.join(ov.overlayDir(name), rel)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${name}/${rel} does not parse:\n${r.stderr}`);
      checked += 1;
    }
  }
  assert.equal(checked, 3 * 2 + 3 * 1);
});

test('main carries no TODO(module- markers in src/agent.js or src/telemetry.js', () => {
  for (const rel of ov.OVERLAY_SOURCE_FILES) assert.ok(!mainSrc(rel).includes('TODO(module-'), rel);
});

// ---------------------------------------------------------------------------------------------
// The hunk rule

const norm = (l) => l.trim().replace(/^\/\/\s?/, '').trim();

for (const name of NAMES) {
  test(`${name}: diff vs main is non-empty and every hunk carries TODO(module-`, () => {
    requireOverlay(name);
    const files = ov.listOverlayFiles(name).filter((f) => ov.OVERLAY_SOURCE_FILES.includes(f));
    assert.ok(files.length > 0, 'the overlay changes at least one source file');
    for (const rel of files) {
      const hunks = ov.diffHunks(path.join(ROOT, rel), path.join(ov.overlayDir(name), rel));
      assert.ok(hunks.length > 0, `${name}/${rel} differs from main (otherwise it must be omitted)`);
      for (const h of hunks) {
        const changed = [...h.removed, ...h.added];
        assert.ok(
          changed.some((l) => l.includes('TODO(module-')),
          `${name}/${rel}: hunk ${h.header} changes lines with no TODO(module- marker:\n${changed.map((l) => `  | ${l}`).join('\n')}`,
        );
        const removed = h.removed.map(norm).filter((l) => l !== '');
        if (removed.length > 0) {
          const added = new Set(h.added.map(norm));
          assert.ok(
            removed.some((l) => !added.has(l)),
            `${name}/${rel}: hunk ${h.header} re-adds every removed line verbatim (the hint leaks the answer)`,
          );
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Shape of the blanks and the hints

test('checkpoint-0/1/2 telemetry.js: the openai one-liner is a TODO(module-2) comment in the same place', () => {
  requireOverlay('checkpoint-2', 'src/telemetry.js');
  const src = ov.readOverlay('checkpoint-2', 'src/telemetry.js');
  assert.ok(!ov.codeLines(src).some((l) => l.includes('new OpenAIInstrumentation(')), 'no `new OpenAIInstrumentation(` in code');
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.includes(TELEMETRY_TODO));
  assert.ok(at !== -1, `a line containing "${TELEMETRY_TODO}"`);
  const mainLines = mainSrc('src/telemetry.js').split('\n');
  const mainAt = mainLines.findIndex((l) => l.includes('new OpenAIInstrumentation()'));
  assert.equal(lines[at - 1], mainLines[mainAt - 1], 'the TODO sits right after the same line as the one-liner on main');
});

test('checkpoint-0/1/2 agent.js: withAgentSpan and withToolSpan are TODO(module-2) pass-throughs', () => {
  requireOverlay('checkpoint-2', 'src/agent.js');
  const src = ov.readOverlay('checkpoint-2', 'src/agent.js');
  for (const fn of ['withAgentSpan', 'withToolSpan']) {
    const body = ov.functionBody(src, fn);
    assert.deepEqual(ov.codeLines(body), ['return run();'], `${fn} body is a pass-through`);
    assert.ok(body.includes('TODO(module-2)'), `${fn} body carries TODO(module-2)`);
  }
  assert.ok(!ov.codeLines(src).some((l) => l.includes('startActiveSpan')), 'no span is started anywhere');
});

test('checkpoint-2 agent.js: the TODO blocks hint at invoke_agent and execute_tool', () => {
  requireOverlay('checkpoint-2', 'src/agent.js');
  const hints = ov.todoBlocks(ov.readOverlay('checkpoint-2', 'src/agent.js')).join('\n');
  assert.match(hints, /invoke_agent/);
  assert.match(hints, /execute_tool/);
});

test('checkpoint-2-cut agent.js: invoke_agent filled (operation + agent name only), execute_tool blank', () => {
  requireOverlay('checkpoint-2-cut', 'src/agent.js');
  const src = ov.readOverlay('checkpoint-2-cut', 'src/agent.js');
  const agentBody = ov.functionBody(src, 'withAgentSpan');
  const agentCode = ov.codeLines(agentBody).join('\n');
  assert.match(agentCode, /startActiveSpan/);
  assert.match(agentCode, /'gen_ai\.operation\.name'\s*:\s*'invoke_agent'/);
  assert.match(agentCode, /'gen_ai\.agent\.name'\s*:/);
  for (const key of ['gen_ai.prompt.name', 'gen_ai.prompt.version', 'gen_ai.conversation.id', 'roastjudge.verdict.score']) {
    assert.ok(!agentCode.includes(`'${key}'`), `${key} is not stamped yet`);
  }
  assert.ok(agentBody.includes('TODO(module-3)'), 'TODO(module-3) marks the prompt / verdict attrs');
  assert.ok(agentBody.includes('TODO(module-4c)'), 'TODO(module-4c) marks gen_ai.conversation.id');
  const toolBody = ov.functionBody(src, 'withToolSpan');
  assert.deepEqual(ov.codeLines(toolBody), ['return run();']);
  assert.ok(toolBody.includes('TODO(module-2)'));
});

test('checkpoint-3/4 agent.js: Module 2 + 3 present, conversation.id is a TODO(module-4c)', () => {
  requireOverlay('checkpoint-3', 'src/agent.js');
  const src = ov.readOverlay('checkpoint-3', 'src/agent.js');
  const code = ov.codeLines(src).join('\n');
  assert.ok(src.includes(CONV_TODO), `contains "${CONV_TODO}"`);
  assert.doesNotMatch(code, /'gen_ai\.conversation\.id'\s*:/);
  for (const key of ['gen_ai.prompt.name', 'gen_ai.prompt.version', 'roastjudge.verdict.score', 'gen_ai.tool.call.id']) {
    assert.ok(code.includes(`'${key}'`), `${key} still stamped`);
  }
  assert.ok(ov.todoBlocks(src).some((b) => b.includes('gen_ai.conversation.id')));
});

// ---------------------------------------------------------------------------------------------
// Behaviour: apply each overlay to a copy of the repo and run verify / check-spans (in parallel)

const copies = [];
const results = {}; // name -> { verify, checkSpans, cross? }
const RUN_TIMEOUT = 90000;

before(async () => {
  const run = (dir, script, args = []) =>
    runNode([script, ...args], { cwd: dir, timeoutMs: RUN_TIMEOUT }).then(summarise);
  await Promise.all(
    NAMES.filter(exists).map(async (name) => {
      const dir = copyRepo();
      copies.push(dir);
      ov.applyOverlay(dir, name);
      const jobs = [run(dir, 'scripts/verify.cjs'), run(dir, 'scripts/check-spans.cjs')];
      if (name === 'checkpoint-4') jobs.push(run(dir, 'scripts/verify.cjs', ['main']));
      if (name === 'checkpoint-2-cut') jobs.push(run(dir, 'scripts/verify.cjs', ['checkpoint-3']));
      const [verify, checkSpans, cross] = await Promise.all(jobs);
      results[name] = { verify, checkSpans, cross };
    }),
  );
});
after(() => copies.forEach(removeCopy));

for (const name of NAMES) {
  test(`${name}: verify (reading the overlay's CHECKPOINT) PASSes`, () => {
    requireOverlay(name);
    const r = results[name].verify;
    assert.equal(r.status, 0, r.info);
    assert.equal(r.last, `PASS ${name}: ${setSize(name)} checks`, r.info);
  });

  const fails = FAILS_CHECK_SPANS.has(name);
  test(`${name}: check-spans exits ${fails ? 1 : 0}`, () => {
    requireOverlay(name);
    const r = results[name].checkSpans;
    assert.equal(r.status, fails ? 1 : 0, r.info);
    if (!fails) assert.match(r.last, /^PASS module-2: \d+ checks$/, r.info);
    if (['checkpoint-0', 'checkpoint-1', 'checkpoint-2'].includes(name)) {
      assert.ok(r.stdout.includes('missing span `invoke_agent roast-judge`'), r.info);
      assert.ok(r.stdout.includes('missing span `chat gpt-4.1-mini`'), r.info);
    }
    if (name === 'checkpoint-2-cut') {
      assert.ok(r.stdout.includes('missing span `execute_tool score_component`'), r.info);
      assert.ok(!r.stdout.includes('missing span `chat'), r.info);
      assert.ok(!r.stdout.includes('missing span `invoke_agent'), r.info);
    }
  });
}

test('discrimination: the checkpoint-4 tree fails `verify main` (no conversation.id)', () => {
  requireOverlay('checkpoint-4');
  const r = results['checkpoint-4'].cross;
  assert.equal(r.status, 1, r.info);
  assert.match(r.last, /^FAIL main\b/, r.info);
  assert.match(r.stdout, /conversation\.id/, r.info);
});

test('discrimination: the checkpoint-2-cut tree fails `verify checkpoint-3`', () => {
  requireOverlay('checkpoint-2-cut');
  const r = results['checkpoint-2-cut'].cross;
  assert.equal(r.status, 1, r.info);
  assert.match(r.last, /^FAIL checkpoint-3\b/, r.info);
});
