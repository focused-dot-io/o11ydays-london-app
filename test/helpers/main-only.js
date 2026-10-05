'use strict';

// Test helper (no `.test.js` suffix): skip tests that only hold on the finished `main`.
//
// The checkpoint branches are `main` with checkpoints/<name>/ copied over the tree and checkpoints/
// deleted (scripts/build-checkpoints.sh), so some of the suite cannot hold there: the tests of the
// overlays themselves, the "PASS on main" runs of verify / check-spans, and the Module 2 trace
// shape that the attendee has not built yet. Pass `mainOnly` as the options argument:
//
//   test('verify module-2: PASS on main', mainOnly, () => { ... });
//
// On main it is an empty object and the test runs. Anywhere else (CHECKPOINT is not `main`) the
// test is skipped with a reason, so `npm test` is green on every checkpoint branch and the checks
// that matter there stay live. test/checkpoint-suite.test.js proves that on a checkpoint-0 copy.

const { readCheckpoint } = require('../../scripts/lib/run-checks.cjs');

const CHECKPOINT = readCheckpoint();
const ON_MAIN = CHECKPOINT === 'main';
const mainOnly = ON_MAIN
  ? {}
  : { skip: `holds on main only; this tree is ${CHECKPOINT || 'unknown'} (its own check is npm run verify)` };

module.exports = { CHECKPOINT, ON_MAIN, mainOnly };
