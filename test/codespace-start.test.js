'use strict';

// Phase 6: scripts/codespace-start.sh (devcontainer postStartCommand).
// SPEC: idempotently restarts app + load generator.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - bash. Pidfiles and logs are relative to the current working directory (the workspace root in a
//    Codespace): .dev.pid / .dev.log for `node scripts/dev.mjs`, .load.pid / .load.log for
//    `node scripts/load.mjs` (scripts resolved relative to the script's own directory).
//  - For each of app (dev.mjs) and load: if its pidfile holds a live pid, send SIGHUP to that pid
//    (dev.mjs restarts its children; load.mjs, if it handles SIGHUP, just continues) and print
//    `app: restarted` / `load: restarted`; otherwise start it detached with nohup, logging to the log
//    file, write `$!` to the pidfile, and print `app: started` / `load: started`.
//  - CODESPACE_START_DRY_RUN=1: decide and print exactly the same `app: ...` / `load: ...` lines but
//    send no signals, spawn nothing and write no files. Exit 0.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, runBash } = require('./helpers/run-script.js');

const SCRIPT = path.join(ROOT, 'scripts', 'codespace-start.sh');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-codespace-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The dry run must never signal us; if it did, fail loudly instead of dying.
let gotHup = 0;
process.on('SIGHUP', () => {
  gotHup += 1;
});

let n = 0;
function caseDir(files = {}) {
  n += 1;
  const dir = path.join(tmp, `case-${n}`);
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const dry = (cwd) => runBash([SCRIPT], { cwd, env: { CODESPACE_START_DRY_RUN: '1' }, timeoutMs: 10000 });

function assertNoSideEffects(dir, before) {
  assert.deepEqual(fs.readdirSync(dir).sort(), before.sort(), 'dry run writes no files');
  assert.equal(gotHup, 0, 'dry run sends no SIGHUP');
}

test('codespace-start (dry run): nothing running -> app: started, load: started', async () => {
  const dir = caseDir();
  const res = await dry(dir);
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /^app: started$/m, res.info);
  assert.match(res.stdout, /^load: started$/m, res.info);
  assertNoSideEffects(dir, []);
});

test('codespace-start (dry run): live pids -> restarted', async () => {
  const dir = caseDir({ '.dev.pid': `${process.pid}\n`, '.load.pid': `${process.pid}\n` });
  const res = await dry(dir);
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /^app: restarted$/m, res.info);
  assert.match(res.stdout, /^load: restarted$/m, res.info);
  assertNoSideEffects(dir, ['.dev.pid', '.load.pid']);
});

test('codespace-start (dry run): stale pids -> started; mixed live/stale handled per process', async () => {
  const stale = caseDir({ '.dev.pid': '999999\n', '.load.pid': '999999\n' });
  const a = await dry(stale);
  assert.equal(a.status, 0, a.info);
  assert.match(a.stdout, /^app: started$/m, a.info);
  assert.match(a.stdout, /^load: started$/m, a.info);
  assertNoSideEffects(stale, ['.dev.pid', '.load.pid']);

  const mixed = caseDir({ '.dev.pid': `${process.pid}\n`, '.load.pid': '999999\n' });
  const b = await dry(mixed);
  assert.equal(b.status, 0, b.info);
  assert.match(b.stdout, /^app: restarted$/m, b.info);
  assert.match(b.stdout, /^load: started$/m, b.info);
  assertNoSideEffects(mixed, ['.dev.pid', '.load.pid']);
});

test('codespace-start (dry run): garbage in a pidfile is treated as not running', async () => {
  const dir = caseDir({ '.dev.pid': 'not-a-pid\n' });
  const res = await dry(dir);
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /^app: started$/m, res.info);
  assertNoSideEffects(dir, ['.dev.pid']);
});
