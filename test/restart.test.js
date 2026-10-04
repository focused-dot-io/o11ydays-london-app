'use strict';

// scripts/restart.mjs (`npm run restart`): restarts the running `npm run dev` via SIGHUP to the pid in
// .dev.pid and waits until all three services answer /healthz again. Module 2 and 3 use it after
// editing src/, because the OTel SDK only starts with a new process.
//
//  - With a live dev.mjs: exits 0, prints `app: restarted`, and dev.mjs has started all three again.
//  - No live pid and nothing on the app port: exits 1 and says to start npm run dev.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freePort } = require('./helpers/app-harness.js');
const { runNode, spawnLong, waitFor } = require('./helpers/run-script.js');

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-restart-'));
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

const startedCount = (s) => (s.stdout.match(/started \S+ on :\d+/g) || []).length;

test('restart.mjs: restarts a running npm run dev and waits until all three answer', { timeout: 40000 }, async () => {
  const [app, pub, replay] = [await freePort(), await freePort(), await freePort()];
  const ports = [app, pub, replay];
  const pidfile = path.join(tmp, 'dev.pid');
  const env = {
    ROASTJUDGE_EXPORTER: 'console',
    PORT: String(app),
    PUB_GUIDE_PORT: String(pub),
    REPLAY_PORT: String(replay),
    DEV_PIDFILE: pidfile,
    REPLAY_LATENCY_SCALE: '0',
    REPLAY_FAIL_EVERY: '0',
  };
  dev = spawnLong(process.execPath, ['scripts/dev.mjs'], { env });
  const up = await waitFor(async () => (await Promise.all(ports.map(healthy))).every(Boolean) || Boolean(dev.exited), 10000, 100);
  assert.ok(up && !dev.exited, `all three /healthz within 10 s\n${dev.info()}`);

  const before = startedCount(dev);
  const r = await runNode(['scripts/restart.mjs'], {
    env: {
      DEV_PIDFILE: pidfile,
      ROASTJUDGE_URL: `http://127.0.0.1:${app}`,
      PUB_GUIDE_URL: `http://127.0.0.1:${pub}`,
      REPLAY_URL: `http://127.0.0.1:${replay}/v1`,
    },
    timeoutMs: 30000,
  });
  assert.equal(r.status, 0, r.info);
  assert.match(r.stdout, /app: restarted/, r.info);
  assert.ok(startedCount(dev) >= before + 3, `dev.mjs restarted all three (started lines ${before} -> ${startedCount(dev)})\n${dev.info()}`);
  assert.ok((await Promise.all(ports.map(healthy))).every(Boolean), 'all three answer when restart returns');

  dev.child.kill('SIGTERM');
  await waitFor(() => Boolean(dev.exited), 5000, 50);
});

test('restart.mjs: nothing running exits 1 and says to start npm run dev', async () => {
  const port = await freePort();
  const r = await runNode(['scripts/restart.mjs'], {
    env: { DEV_PIDFILE: path.join(tmp, 'missing.pid'), ROASTJUDGE_URL: `http://127.0.0.1:${port}` },
  });
  assert.equal(r.status, 1, r.info);
  assert.match(r.stderr, /npm run dev/, r.info);
});
