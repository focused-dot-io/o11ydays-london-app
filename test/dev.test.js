'use strict';

// Phase 6: scripts/dev.mjs (`npm run dev`), the local supervisor for the three services.
// SPEC: forks the three services with --env-file-if-exists=.env, restarts on crash, pidfile for
// codespace-start.sh.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - Children: pub-guide `node --env-file-if-exists=<repo>/.env --require ./services/pub-guide/telemetry.js
//    --disable-warning=ExperimentalWarning services/pub-guide/server.js`; app the same with
//    `--require ./src/telemetry.js src/server.js`; replay `node --env-file-if-exists=<repo>/.env
//    services/model-replay/server.js` (no telemetry). Children inherit dev.mjs's env.
//  - Ports from PORT / PUB_GUIDE_PORT / REPLAY_PORT (defaults 3000/4100/4200): app child gets PORT,
//    pub-guide child PORT=$PUB_GUIDE_PORT, replay child PORT=$REPLAY_PORT; the app child gets
//    REPLAY_URL=http://localhost:$REPLAY_PORT/v1 and PUB_GUIDE_URL=http://localhost:$PUB_GUIDE_PORT
//    unless those are already set in dev.mjs's env.
//  - Prints `started <name> on :<port>` each time a child is (re)started (so a restart of all three
//    prints three more such lines); prints `restarting <name>` when a crashed child is restarted
//    (with backoff).
//  - Writes its own pid to .dev.pid (override DEV_PIDFILE) and removes it on exit.
//  - SIGHUP: restart all three children. SIGINT/SIGTERM: kill children, remove pidfile, exit 0.
//  - A file change under DEV_WATCH_DIR (default src/) restarts only the app, printing
//    `<file> changed: restarting app`; DEV_WATCH=0 turns watching off.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { freePort } = require('./helpers/app-harness.js');
const { ROOT, spawnLong, waitFor } = require('./helpers/run-script.js');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-dev-'));
let dev;

after(async () => {
  if (dev) await dev.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

const startedCount = (s) => (s.stdout.match(/started \S+ on :\d+/g) || []).length;

test('dev.mjs source forks children with --env-file-if-exists and the telemetry requires', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'dev.mjs'), 'utf8');
  assert.match(src, /--env-file-if-exists/);
  assert.match(src, /services\/pub-guide\/telemetry\.js/);
  assert.match(src, /src\/telemetry\.js/);
  assert.match(src, /--disable-warning=ExperimentalWarning/);
});

test('dev.mjs: starts all three, serves /judge, restarts on SIGHUP, exits cleanly on SIGTERM', { timeout: 30000 }, async () => {
  const [app, pub, replay] = [await freePort(), await freePort(), await freePort()];
  const ports = [app, pub, replay];
  const pidfile = path.join(tmp, 'dev.pid');
  dev = spawnLong(process.execPath, ['scripts/dev.mjs'], {
    env: {
      ROASTJUDGE_EXPORTER: 'console',
      PORT: String(app),
      PUB_GUIDE_PORT: String(pub),
      REPLAY_PORT: String(replay),
      DEV_PIDFILE: pidfile,
      REPLAY_LATENCY_SCALE: '0',
      REPLAY_FAIL_EVERY: '0',
    },
  });

  const up = await waitFor(async () => (await Promise.all(ports.map(healthy))).every(Boolean) || Boolean(dev.exited), 10000, 100);
  assert.ok(up && !dev.exited, `all three /healthz within 10 s\n${dev.info()}`);
  for (const p of ports) assert.match(dev.stdout, new RegExp(`started \\S+ on :${p}\\b`), `started line for :${p}\n${dev.info()}`);

  assert.ok(fs.existsSync(pidfile), 'pidfile written');
  assert.equal(fs.readFileSync(pidfile, 'utf8').trim(), String(dev.child.pid));

  const res = await fetch(`http://127.0.0.1:${app}/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roastjudge-model': 'replay' },
    body: JSON.stringify({ text: require('../replay/corpus.json')[0].text }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, `POST /judge through the dev-run app: ${body}\n${dev.info()}`);
  assert.match(JSON.parse(body).trace_id, /^[0-9a-f]{32}$/);

  const before = startedCount(dev);
  dev.child.kill('SIGHUP');
  const restarted = await waitFor(() => startedCount(dev) >= before + 3 || Boolean(dev.exited), 5000, 50);
  assert.ok(restarted && !dev.exited, `SIGHUP restarts all three (started lines ${before} -> ${startedCount(dev)})\n${dev.info()}`);
  const upAgain = await waitFor(async () => (await Promise.all(ports.map(healthy))).every(Boolean), 5000, 100);
  assert.ok(upAgain, `all three /healthz again after SIGHUP\n${dev.info()}`);
  assert.equal(dev.exited, null, 'dev survives SIGHUP');

  dev.child.kill('SIGTERM');
  const exited = await waitFor(() => Boolean(dev.exited), 5000, 50);
  assert.ok(exited, `exits within 5 s of SIGTERM\n${dev.info()}`);
  assert.equal(dev.exited.code, 0, dev.info());
  assert.ok(!fs.existsSync(pidfile), 'pidfile removed on exit');
  const free = await waitFor(async () => (await Promise.all(ports.map(portFree))).every(Boolean), 3000, 100);
  assert.ok(free, 'all three ports free after exit (children killed)');
});

test('dev.mjs: a file change under the watched directory restarts only the app', { timeout: 30000 }, async () => {
  const [app, pub, replay] = [await freePort(), await freePort(), await freePort()];
  const ports = [app, pub, replay];
  const watchDir = fs.mkdtempSync(path.join(tmp, 'watch-'));
  const w = spawnLong(process.execPath, ['scripts/dev.mjs'], {
    env: {
      ROASTJUDGE_EXPORTER: 'console',
      PORT: String(app),
      PUB_GUIDE_PORT: String(pub),
      REPLAY_PORT: String(replay),
      DEV_PIDFILE: path.join(tmp, 'dev-watch.pid'),
      DEV_WATCH_DIR: watchDir,
      REPLAY_LATENCY_SCALE: '0',
      REPLAY_FAIL_EVERY: '0',
    },
  });
  try {
    const up = await waitFor(async () => (await Promise.all(ports.map(healthy))).every(Boolean) || Boolean(w.exited), 10000, 100);
    assert.ok(up && !w.exited, `all three /healthz within 10 s\n${w.info()}`);
    assert.match(w.stdout, /watching /, w.info());

    const before = startedCount(w);
    fs.writeFileSync(path.join(watchDir, 'agent.js'), '// edited\n');
    const restarted = await waitFor(() => /agent\.js changed: restarting app/.test(w.stdout) && startedCount(w) >= before + 1, 5000, 50);
    assert.ok(restarted, `file change restarts the app\n${w.info()}`);
    const upAgain = await waitFor(async () => healthy(app), 5000, 100);
    assert.ok(upAgain, `app /healthz again after the restart\n${w.info()}`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(startedCount(w), before + 1, `only the app restarts, once\n${w.info()}`);
  } finally {
    w.child.kill('SIGTERM');
    await waitFor(() => Boolean(w.exited), 5000, 50);
  }
});
