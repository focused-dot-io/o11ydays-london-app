'use strict';

// SPEC: `npm test` is green on every checkpoint branch, not only on main.
//
// A checkpoint branch is main with checkpoints/<name>/ copied over the tree and checkpoints/
// deleted (scripts/build-checkpoints.sh). Tests that only hold on the finished main take
// `mainOnly` (test/helpers/main-only.js) and are skipped there. This test builds that tree for
// the two extremes, checkpoint-0 (the least code) and checkpoint-4 (the most), in throwaway
// copies of the repo and runs `npm test` in each (Docker tests off): zero failures, a real number
// of passes, and at least as many skips as there are mainOnly tests. On a checkpoint branch this
// test is itself mainOnly, which also keeps it from nesting.

const { test, after } = require('node:test');
const { mainOnly } = require('./helpers/main-only.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { copyRepo, removeCopy } = require('./helpers/repo-copy.js');
const ov = require('./helpers/checkpoint-overlays.js');

const MAIN_ONLY_TESTS = 47; // `grep -c 'mainOnly,' test/*.test.js` (sum), excluding this file
const copies = [];
after(() => copies.forEach(removeCopy));

function checkpointTree(name) {
  const dir = copyRepo();
  copies.push(dir);
  ov.applyOverlay(dir, name);
  fs.rmSync(path.join(dir, 'checkpoints'), { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(dir, 'CHECKPOINT'), 'utf8'), `${name}\n`);
  return dir;
}

/**
 * `npm test` in `cwd`; stdout is TAP because it is a pipe. Without the Docker tests: two more
 * compose stacks and image builds next to the outer suite's own made that outer run flaky, and the
 * Docker tests run on the real checkpoint branches anyway (their one Module 2 assertion is gated).
 */
function npmTest(cwd) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['test'], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SKIP_DOCKER_TESTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

const count = (out, key) => {
  const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(out);
  return m ? Number(m[1]) : NaN;
};

test('npm test passes on checkpoint-0 and checkpoint-4 trees (mainOnly tests skipped)', mainOnly, async () => {
  const names = ['checkpoint-0', 'checkpoint-4'];
  const runs = await Promise.all(names.map((n) => npmTest(checkpointTree(n))));
  for (const [i, r] of runs.entries()) {
    const name = names[i];
    const failing = r.out.split('\n').filter((l) => l.startsWith('not ok')).join('\n');
    const info = `${name}: exit=${r.status}\n--- failing\n${failing}\n--- stderr (tail)\n${r.err.slice(-2000)}`;
    assert.equal(count(r.out, 'fail'), 0, info);
    assert.equal(r.status, 0, info);
    assert.ok(count(r.out, 'pass') > 400, `${name}: pass=${count(r.out, 'pass')}`);
    assert.ok(count(r.out, 'skipped') >= MAIN_ONLY_TESTS, `${name}: skipped=${count(r.out, 'skipped')}`);
  }
});
