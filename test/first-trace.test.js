'use strict';

// Phase 4: scripts/first-trace.mjs (`npm run first-trace`), run against the real app via the harness.
// SPEC: POSTs one corpus roast, prints the trace ID, the dataset name `roast-judge-<seat>`, and a UI
// link if HONEYCOMB_TEAM_SLUG / HONEYCOMB_ENV_SLUG are set.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - The app's base URL comes from ROASTJUDGE_URL (default http://localhost:3000).
//  - The seat comes from SEAT (default 0); the dataset name printed is `roast-judge-${SEAT}`.
//  - The trace id printed is the 32-hex `trace_id` from the /judge response (it must exist in the
//    app's spans).
//  - UI link format (US region):
//      https://ui.honeycomb.io/<team>/environments/<env>/datasets/roast-judge-<seat>/trace?trace_id=<id>
//    printed only when BOTH slugs are set; no `ui.honeycomb.io` link otherwise.
//  - Exit code 0 on success; the script does not need telemetry (run with plain `node`).
//  - The script must not read a .env file that would override the env given here (the test passes a
//    controlled env with only PATH/HOME inherited).

const { test, before, after } = require('node:test');
const { mainOnly } = require('./helpers/main-only.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHarness } = require('./helpers/app-harness.js');

const ROOT = path.join(__dirname, '..');
const HEX32_G = /\b[0-9a-f]{32}\b/g;

let h;

before(async () => {
  h = await createHarness();
}, { timeout: 20000 });

after(async () => {
  if (h) await h.stop();
});

function runFirstTrace(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/first-trace.mjs'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, info: `exit=${status} signal=${signal}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}` });
    });
  });
}

test('first-trace: prints the trace id and dataset roast-judge-<seat>; the trace exists in the app', mainOnly, async () => {
  const res = await runFirstTrace({ ROASTJUDGE_URL: h.appUrl, SEAT: '0' });
  assert.equal(res.status, 0, res.info);
  const ids = res.stdout.match(HEX32_G) || [];
  assert.ok(ids.length >= 1, `a 32-hex trace id in stdout\n${res.info}`);
  assert.match(res.stdout, /roast-judge-0/, res.info);
  assert.doesNotMatch(res.stdout, /ui\.honeycomb\.io/, 'no UI link without the slugs');

  const spans = await h.traceSpans(ids[0]);
  assert.ok(
    spans.some((s) => s.name === 'invoke_agent roast-judge'),
    `the printed trace id is a real judge trace in the app (${ids[0]})\n${res.info}`,
  );
});

test('first-trace: the dataset name follows SEAT', async () => {
  const res = await runFirstTrace({ ROASTJUDGE_URL: h.appUrl, SEAT: '5' });
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /roast-judge-5/, res.info);
});

test('first-trace: prints the US Honeycomb UI link when team and env slugs are set', async () => {
  const res = await runFirstTrace({
    ROASTJUDGE_URL: h.appUrl,
    SEAT: '0',
    HONEYCOMB_TEAM_SLUG: 'team',
    HONEYCOMB_ENV_SLUG: 'env',
  });
  assert.equal(res.status, 0, res.info);
  const ids = res.stdout.match(HEX32_G) || [];
  assert.ok(ids.length >= 1, res.info);
  const url = `https://ui.honeycomb.io/team/environments/env/datasets/roast-judge-0/trace?trace_id=${ids[0]}`;
  assert.ok(res.stdout.includes(url), `expected ${url}\n${res.info}`);
});

test('npm run first-trace reads the seat and link from .env, while shell values win', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-first-trace-env-'));
  try {
    for (const file of ['package.json', 'scripts/first-trace.mjs', 'replay/corpus.json']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
    }
    fs.writeFileSync(path.join(dir, '.env'), `SEAT=917\nROASTJUDGE_URL=${h.appUrl}\nHONEYCOMB_TEAM_SLUG=team\nHONEYCOMB_ENV_SLUG=env\n`);
    const run = (extra = {}) => new Promise((resolve) => {
      const child = spawn('npm', ['run', 'first-trace'], {
        cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      child.on('close', (status) => resolve({ status, output }));
    });
    const fromFile = await run();
    assert.equal(fromFile.status, 0, fromFile.output);
    assert.match(fromFile.output, /Dataset:\s+roast-judge-917/);
    assert.match(fromFile.output, /\/team\/environments\/env\/datasets\/roast-judge-917\/trace/);
    const fromShell = await run({ SEAT: '5' });
    assert.equal(fromShell.status, 0, fromShell.output);
    assert.match(fromShell.output, /Dataset:\s+roast-judge-5/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
