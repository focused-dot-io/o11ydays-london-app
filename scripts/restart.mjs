// npm run restart: restart the running `npm run dev` so it picks up your code changes, and wait
// until the app answers again.
//
// The OTel SDK starts once, when the app process starts (`--require ./src/telemetry.js`), so a change
// to src/telemetry.js or src/agent.js only takes effect in a new process. This sends SIGHUP to the
// pid in .dev.pid (the same restart `npm run catchup` does), waits for the app to go down, then waits
// until the app, pub-guide and the replay model all answer /healthz. Any restart puts the judge back
// on prompt v1.
//
// Env: DEV_PIDFILE (default .dev.pid), ROASTJUDGE_URL, PUB_GUIDE_URL, REPLAY_URL (from .env).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIDFILE = path.resolve(ROOT, process.env.DEV_PIDFILE || '.dev.pid');
const DOWN_WAIT_MS = 3000;
const UP_WAIT_MS = 20000;
const STEP_MS = 100;

const origin = (url) => new URL(url).origin;
const services = [
  ['app', origin(process.env.ROASTJUDGE_URL || 'http://localhost:3000')],
  ['pub-guide', origin(process.env.PUB_GUIDE_URL || 'http://localhost:4100')],
  ['replay', origin(process.env.REPLAY_URL || 'http://localhost:4200/v1')],
];
const appUrl = services[0][1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(base) {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(STEP_MS);
  }
}

function livePid() {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const pid = livePid();
if (!pid) {
  if (await healthy(appUrl)) {
    console.log(`No npm run dev to restart (${path.relative(ROOT, PIDFILE)}), but the app is up at ${appUrl}.`);
    console.log('Under docker compose, saving the file already restarted it. Otherwise stop the app and start it again.');
    process.exit(0);
  }
  console.error(`The app isn't running at ${appUrl}. Start it with: npm run dev`);
  process.exit(1);
}

process.kill(pid, 'SIGHUP');
console.log('app: restarting...');

// The old process answers until it stops; wait to see it go down so we don't report the old one.
await waitFor(async () => !(await healthy(appUrl)), DOWN_WAIT_MS);

const up = await waitFor(async () => (await Promise.all(services.map(([, base]) => healthy(base)))).every(Boolean), UP_WAIT_MS);
if (!up) {
  const down = [];
  for (const [name, base] of services) if (!(await healthy(base))) down.push(`${name} (${base})`);
  console.error(`app: not back after ${UP_WAIT_MS / 1000} s: ${down.join(', ')} not answering. Check the terminal running npm run dev.`);
  process.exit(1);
}
console.log('app: restarted on your current code (prompt is back on v1)');
