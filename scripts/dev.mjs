// npm run dev: run the three Roast Judge services locally and keep them running.
//
//   pub-guide  services/pub-guide/server.js     (with its telemetry)   on PUB_GUIDE_PORT (default 4100)
//   replay     services/model-replay/server.js  (no telemetry)         on REPLAY_PORT    (default 4200)
//   app        src/server.js                    (with its telemetry)   on PORT           (default 3000)
//
// Each child is `node --env-file-if-exists=<repo>/.env ...`, so your .env applies, and inherits this
// process's environment plus its own PORT. The app is pointed at the other two via REPLAY_URL and
// PUB_GUIDE_URL unless you set those yourself.
//
// - A child that crashes is restarted with backoff ("restarting <name>").
// - Saving a file under src/ restarts the app ("src/agent.js changed: restarting app"), so Module 2
//   and 3 edits reach the running app as they do under docker compose's `node --watch`. Override
//   the watched directory with DEV_WATCH_DIR; DEV_WATCH=0 turns watching off.
// - SIGHUP restarts all three (npm run setup and codespace-start.sh send it after changing .env).
// - Ctrl-C / SIGTERM stops all three and exits.
// - Our pid is written to .dev.pid (override with DEV_PIDFILE) and removed on exit.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIDFILE = path.resolve(ROOT, process.env.DEV_PIDFILE || '.dev.pid');

const APP_PORT = process.env.PORT || '3000';
const PUB_GUIDE_PORT = process.env.PUB_GUIDE_PORT || '4100';
const REPLAY_PORT = process.env.REPLAY_PORT || '4200';

const ENV_FILE = `--env-file-if-exists=${path.join(ROOT, '.env')}`;
const NO_WARN = '--disable-warning=ExperimentalWarning';

const SERVICES = [
  {
    name: 'pub-guide',
    port: PUB_GUIDE_PORT,
    args: [ENV_FILE, '--require', './services/pub-guide/telemetry.js', NO_WARN, 'services/pub-guide/server.js'],
    env: { PORT: PUB_GUIDE_PORT },
  },
  {
    name: 'replay',
    port: REPLAY_PORT,
    args: [ENV_FILE, NO_WARN, 'services/model-replay/server.js'],
    env: { PORT: REPLAY_PORT },
  },
  {
    name: 'app',
    port: APP_PORT,
    args: [ENV_FILE, '--require', './src/telemetry.js', NO_WARN, 'src/server.js'],
    env: {
      PORT: APP_PORT,
      REPLAY_URL: process.env.REPLAY_URL || `http://localhost:${REPLAY_PORT}/v1`,
      PUB_GUIDE_URL: process.env.PUB_GUIDE_URL || `http://localhost:${PUB_GUIDE_PORT}`,
    },
  },
];

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 10000;
const HEALTHY_AFTER_MS = 10000; // a child that ran this long resets its crash backoff
const KILL_GRACE_MS = 3000;
const WATCH_DEBOUNCE_MS = 300;
const WATCH_DIR = path.resolve(ROOT, process.env.DEV_WATCH_DIR || 'src');

let stopping = false;
// Per service: { child, timer, backoff, startedAt }
const state = new Map(SERVICES.map((s) => [s.name, { child: null, timer: null, backoff: BACKOFF_START_MS, startedAt: 0 }]));

function start(service) {
  const st = state.get(service.name);
  st.timer = null;
  const child = spawn(process.execPath, service.args, {
    cwd: ROOT,
    env: { ...process.env, ...service.env },
    stdio: 'inherit',
  });
  st.child = child;
  st.startedAt = Date.now();
  console.log(`started ${service.name} on :${service.port}`);

  child.on('exit', (code, signal) => {
    if (st.child !== child) return; // replaced or deliberately stopped
    st.child = null;
    if (stopping) return;
    if (Date.now() - st.startedAt > HEALTHY_AFTER_MS) st.backoff = BACKOFF_START_MS;
    console.log(`${service.name} exited (${signal || `code ${code}`}); restarting ${service.name} in ${st.backoff} ms`);
    st.timer = setTimeout(() => start(service), st.backoff);
    st.backoff = Math.min(st.backoff * 2, BACKOFF_MAX_MS);
  });
}

/** Stop every child (SIGTERM, then SIGKILL after a grace period) and wait until they have exited. */
async function stopAll() {
  const waits = [];
  for (const st of state.values()) {
    clearTimeout(st.timer);
    st.timer = null;
    const child = st.child;
    st.child = null; // tells the exit handler this exit is deliberate
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    waits.push(
      new Promise((resolve) => {
        const force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill('SIGTERM');
      }),
    );
  }
  await Promise.all(waits);
}

/** Restart one service now (file change), resetting its crash backoff. */
function restartService(service, reason) {
  const st = state.get(service.name);
  console.log(`${reason}: restarting ${service.name}`);
  clearTimeout(st.timer);
  st.timer = null;
  st.backoff = BACKOFF_START_MS;
  const child = st.child;
  st.child = null; // tells the exit handler this exit is deliberate
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    start(service);
    return;
  }
  const force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  child.once('exit', () => {
    clearTimeout(force);
    if (!stopping && !restarting && !st.child) start(service);
  });
  child.kill('SIGTERM');
}

/** Restart the app when anything under WATCH_DIR changes (debounced: editors write in bursts). */
function watchApp() {
  if (process.env.DEV_WATCH === '0') return;
  const app = SERVICES.find((s) => s.name === 'app');
  let pending = null;
  try {
    fs.watch(WATCH_DIR, { recursive: true }, (_event, file) => {
      if (stopping) return;
      clearTimeout(pending);
      const changed = path.relative(ROOT, path.join(WATCH_DIR, file || ''));
      pending = setTimeout(() => {
        if (!stopping && !restarting) restartService(app, `${changed} changed`);
      }, WATCH_DEBOUNCE_MS);
    });
    console.log(`watching ${path.relative(ROOT, WATCH_DIR) || '.'}/: saving a file there restarts the app`);
  } catch (err) {
    console.log(`not watching ${WATCH_DIR} (${err.message}); after editing, restart with: kill -HUP $(cat .dev.pid)`);
  }
}

let restarting = null;
async function restartAll() {
  if (restarting) return restarting;
  console.log('SIGHUP: restarting all services');
  restarting = (async () => {
    await stopAll();
    if (stopping) return;
    for (const st of state.values()) st.backoff = BACKOFF_START_MS;
    SERVICES.forEach(start);
  })().finally(() => {
    restarting = null;
  });
  return restarting;
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopAll();
  process.exit(0);
}

function removePidfile() {
  try {
    if (fs.readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PIDFILE);
  } catch {
    // already gone
  }
}

// Last line of defence: never leave children running, whatever way we exit.
process.on('exit', () => {
  for (const st of state.values()) if (st.child) st.child.kill('SIGKILL');
  removePidfile();
});

process.on('SIGHUP', restartAll);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

fs.writeFileSync(PIDFILE, `${process.pid}\n`);
SERVICES.forEach(start);
watchApp();
