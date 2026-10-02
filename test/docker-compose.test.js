'use strict';

// Phase 8 (slow, needs a running Docker daemon): `docker compose up` really runs Roast Judge.
// SPEC: "Run with `docker compose up` (three services, bind mount, `node --watch`)"; Dockerfile pinned
// to node:22.22.0-alpine (one image, three commands).
//
// ASSUMPTIONS (beyond SPEC.md; see test/docker-files.test.js for the file contract):
//  - Host ports are overridable with ROASTJUDGE_PORT / PUB_GUIDE_PORT / REPLAY_PORT and the replay
//    failure rate with REPLAY_FAIL_EVERY (compose interpolation), so this test runs on free ports beside a
//    developer's own stack, under its own project name `rj-test-<pid>`.
//  - The stack runs from a throwaway copy of the repo without .env (so no HONEYCOMB_API_KEY: the app
//    falls back to the console exporter and prints spans, e.g. `invoke_agent roast-judge`, to its log).
//  - Every service has a healthcheck, so `docker compose up -d --wait` returns once all three are healthy.
//  - `node --watch` + the bind mount: touching src/server.js on the host restarts the roast-judge process
//    (node prints `Restarting 'src/server.js'`), and it comes back healthy.
//  - Node 22 coverage: the unit suite runs inside the built image (node 22.22.0 on alpine, node_modules
//    from the image via an anonymous volume, sources via a bind mount of the copy). The alpine image has
//    no git and no bash, so test files that spawn git or bash or docker are left out of that run (selected
//    by file content, including the test/helpers/ modules a file requires: /runBash|'bash'|'git'|docker|verify-setup/). `node --test-skip-pattern` exists in
//    Node 22.22 but filters by test name, not file, so it is not used.
//  - SKIP_DOCKER_TESTS=1 skips this file (as does a missing docker CLI or a failing `docker info`).
//  - Cleanup: `docker compose -p <proj> down -v --remove-orphans --rmi local` always runs afterwards.
// Typical duration on a warm Docker cache: well under a minute; a cold build pulls node:22.22.0-alpine.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { removeCopy } = require('./helpers/repo-copy.js');
const { waitFor } = require('./helpers/run-script.js');
const { dockerSkipReason, freePorts, composeCopy, docker } = require('./helpers/docker.js');

const PROJECT = `rj-test-${process.pid}`;
const reason = dockerSkipReason();
let dir;
let ports;
let env;
let upOk = false;

const compose = (args, timeoutMs) => docker(['compose', '-p', PROJECT, ...args], { cwd: dir, env, timeoutMs });

before(async () => {
  if (reason) return;
  dir = composeCopy();
  ports = await freePorts(3);
  env = {
    ROASTJUDGE_PORT: String(ports[0]),
    PUB_GUIDE_PORT: String(ports[1]),
    REPLAY_PORT: String(ports[2]),
    REPLAY_FAIL_EVERY: '0',
  };
});

after(async () => {
  if (reason || !dir) return;
  await compose(['down', '-v', '--remove-orphans', '--rmi', 'local', '--timeout', '5'], 120000);
  removeCopy(dir);
});

const skipIf = (t) => {
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
};

async function get(port, p) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

test('docker compose config validates and resolves the three services', { timeout: 60000 }, async (t) => {
  if (skipIf(t)) return;
  const r = await compose(['config', '--format', 'json']);
  assert.equal(r.status, 0, r.info);
  const cfg = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(cfg.services).sort(), ['model-replay', 'pub-guide', 'roast-judge']);
  assert.equal(String(cfg.services['roast-judge'].ports[0].published), env.ROASTJUDGE_PORT);
  for (const svc of Object.values(cfg.services)) assert.ok(svc.command.includes('--watch'));
});

test('docker compose build succeeds', { timeout: 5 * 60000 }, async (t) => {
  if (skipIf(t)) return;
  const r = await compose(['build'], 5 * 60000);
  assert.equal(r.status, 0, r.info);
});

test('docker compose up --wait: all three services healthy on the mapped host ports', { timeout: 3 * 60000 }, async (t) => {
  if (skipIf(t)) return;
  const r = await compose(['up', '-d', '--wait', '--wait-timeout', '110'], 2.5 * 60000);
  if (r.status !== 0) {
    const logs = await compose(['logs', '--no-color'], 30000);
    assert.fail(`${r.info}\n--- compose logs ---\n${logs.out.slice(-6000)}`);
  }
  upOk = true;
  for (const port of ports) {
    const h = await get(port, '/healthz');
    assert.equal(h.status, 200, `GET :${port}/healthz -> ${h.status} ${h.body}`);
    assert.deepEqual(JSON.parse(h.body), { ok: true });
  }
});

test('the services run Node 22.22.0 from the pinned image', { timeout: 60000 }, async (t) => {
  if (skipIf(t)) return;
  if (!upOk) return t.skip('stack did not come up');
  for (const svc of ['roast-judge', 'pub-guide', 'model-replay']) {
    const r = await compose(['exec', '-T', svc, 'node', '-p', 'process.versions.node'], 30000);
    assert.equal(r.status, 0, r.info);
    assert.equal(r.stdout.trim(), '22.22.0', `${svc}: ${r.info}`);
  }
});

test('POST /judge through compose returns a verdict (replay model + pub-guide inside compose)', { timeout: 60000 }, async (t) => {
  if (skipIf(t)) return;
  if (!upOk) return t.skip('stack did not come up');
  const res = await fetch(`http://127.0.0.1:${ports[0]}/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Your code review is like a pint at the Prospect of Whitby: flat and overpriced.' }),
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  const body = JSON.parse(raw);
  assert.ok(body.verdict && typeof body.verdict === 'object', raw);
  assert.equal(typeof body.verdict.score, 'number', raw);
  assert.equal(typeof body.verdict.label, 'string', raw);
  assert.equal(typeof body.prompt_version, 'string', raw);
  assert.ok(body.prompt_version, raw);
  assert.match(body.trace_id, /^[0-9a-f]{32}$/, raw);

  // No HONEYCOMB_API_KEY in the copy: spans go to the console exporter, i.e. the container log.
  let logs;
  const seen = await waitFor(async () => {
    logs = await compose(['logs', '--no-color', 'roast-judge'], 30000);
    return logs.out.includes('invoke_agent roast-judge');
  }, 15000, 500);
  assert.ok(seen, `roast-judge log lacks the invoke_agent span:\n${logs && logs.out.slice(-4000)}`);
});

test('node --watch over the bind mount: editing src/server.js restarts roast-judge', { timeout: 90000 }, async (t) => {
  if (skipIf(t)) return;
  if (!upOk) return t.skip('stack did not come up');
  const file = path.join(dir, 'src', 'server.js');
  fs.appendFileSync(file, `\n// touched by docker-compose.test.js ${Date.now()}\n`);
  let logs;
  const restarted = await waitFor(async () => {
    logs = await compose(['logs', '--no-color', 'roast-judge'], 30000);
    return /Restarting '?src\/server\.js'?/.test(logs.out);
  }, 30000, 500);
  assert.ok(restarted, `no node --watch restart in the roast-judge log:\n${logs && logs.out.slice(-3000)}`);
  const back = await waitFor(async () => (await get(ports[0], '/healthz')).status === 200, 30000, 250);
  assert.ok(back, 'roast-judge did not come back after the watch restart');
});

test('the unit suite passes on Node 22.22.0 inside the built image', { timeout: 4 * 60000 }, async (t) => {
  if (skipIf(t)) return;
  const imgs = await compose(['config', '--images'], 30000);
  assert.equal(imgs.status, 0, imgs.info);
  // One image for all three services: compose names it per service, so take roast-judge's.
  const cfg = JSON.parse((await compose(['config', '--format', 'json'], 30000)).stdout);
  const image = cfg.services['roast-judge'].image || `${PROJECT}-roast-judge`;
  assert.ok(imgs.stdout.split(/\s+/).includes(image), `image ${image} not in:\n${imgs.stdout}`);

  const testDir = path.join(dir, 'test');
  // A test needs git/bash/docker if its own text, or the text of any helper it requires from
  // test/helpers/, mentions them (checkpoints.test.js diffs overlays through a helper that runs git).
  const NEEDS_HOST_TOOLS = /runBash|['"]bash['"]|['"]git['"]|docker|verify-setup/;
  const sourceWithHelpers = (f) => {
    const own = fs.readFileSync(path.join(testDir, f), 'utf8');
    const helpers = [...own.matchAll(/require\(['"]\.\/helpers\/([^'"]+)['"]\)/g)]
      .map((m) => path.join(testDir, 'helpers', m[1]))
      .filter((h) => fs.existsSync(h))
      .map((h) => fs.readFileSync(h, 'utf8'));
    return [own, ...helpers].join('\n');
  };
  const files = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !NEEDS_HOST_TOOLS.test(sourceWithHelpers(f)))
    .sort()
    .map((f) => `test/${f}`);
  assert.ok(files.length >= 10, `too few test files selected: ${files.join(' ')}`);

  const r = await docker(
    [
      'run', '--rm',
      '-v', `${dir}:/app`,
      '-v', '/app/node_modules',
      '-w', '/app',
      '-e', 'CI=1',
      image,
      'node', '--disable-warning=ExperimentalWarning', '--test', ...files,
    ],
    { env, timeoutMs: 3.5 * 60000 },
  );
  const failed = r.stdout.split('\n').filter((l) => /^not ok /.test(l)).join('\n');
  assert.equal(r.status, 0, `in-container test run failed (${files.length} files):\n${failed}\n${r.info}`);
  assert.match(r.stdout, /^# fail 0$/m, r.info);
  const pass = Number((r.stdout.match(/^# pass (\d+)$/m) || [])[1]);
  assert.ok(pass > 100, `only ${pass} passing tests in-container`);
});
