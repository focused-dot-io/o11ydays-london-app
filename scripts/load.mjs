// npm run load: the workshop's background load generator. Sends corpus roasts to the running app
// forever, so there is always fresh telemetry to query.
//
// Every request carries `x-roastjudge-model: replay` (free and deterministic, even if the app is
// configured for a live model). About 30% of runs go through all three turns of a conversation
// (judge -> appeal -> final); the rest are a single judge call. Which runs do, and which corpus roast
// each run sends, is deterministic for a given LOAD_SEED, so two runs of the generator look the same.
//
// If the app is down (e.g. restarting) it logs one line, retries with backoff (capped at 4 s) and
// carries on when the app comes back. It never exits on its own; Ctrl-C to stop.
//
// Env:   ROASTJUDGE_URL        app base URL (default http://localhost:3000)
//        LOAD_INTERVAL_MS      pause between runs in ms (default 4000)
//        LOAD_SEED             integer seed for the three-turn pattern and roast order (default 1234)
//        LOAD_ONCE_TIMEOUT_MS  with --once: how long to keep trying to reach the app (default 5000)
// Flags: --once         do one run and exit (0 on success, 1 if the app is unreachable or errors)
//        --three-turns  force every run through judge -> appeal -> final
//        --quiet        no per-run lines (startup and error lines still print)
//
// Output, one line per turn:
//   judge   1f3a9c2e  6/10 solid  trace=<trace id>
//   appeal  1f3a9c2e  7/10 solid  trace=<trace id>
//   final   1f3a9c2e  7/10 solid ruling=overturned  trace=<trace id>

import fs from 'node:fs';

const corpus = JSON.parse(fs.readFileSync(new URL('../replay/corpus.json', import.meta.url), 'utf8'));

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const FORCE_THREE = args.has('--three-turns');
const QUIET = args.has('--quiet');

const BASE = (process.env.ROASTJUDGE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const INTERVAL_MS = numberEnv('LOAD_INTERVAL_MS', 4000);
const SEED = Math.trunc(numberEnv('LOAD_SEED', 1234));
const ONCE_TIMEOUT_MS = numberEnv('LOAD_ONCE_TIMEOUT_MS', 5000);
const THREE_TURN_SHARE = 0.3;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 4000;
const REQUEST_TIMEOUT_MS = 60000;

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Ignoring ${name}=${raw} (not a non-negative number); using ${fallback}.`);
    return fallback;
  }
  return n;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic pseudo-random number in [0, 1) for run `n` under SEED (a small integer hash). */
function random(n, stream) {
  let x = (Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(SEED, 0x85ebca6b) ^ Math.imul(stream + 1, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 2 ** 32;
}

// Round-robin through the corpus, starting at a seed-dependent offset.
const corpusOffset = Math.floor(random(0, 1) * corpus.length);
const itemFor = (n) => corpus[(corpusOffset + n) % corpus.length];
const isThreeTurn = (n) => FORCE_THREE || random(n, 0) < THREE_TURN_SHARE;

/** The app could not be reached at all (connection refused, DNS, timeout): worth retrying. */
class Unreachable extends Error {}
/** The app answered with an error status: it is up, this request just failed. */
class AppError extends Error {}

async function post(path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roastjudge-model': 'replay' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Unreachable(err.cause?.code || err.cause?.message || err.message);
  }
  const raw = await res.text().catch(() => '');
  let json = {};
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON body: reported below
  }
  if (!res.ok || !json.verdict) {
    const what = `${res.status} ${json.error || raw.slice(0, 80)}`.trim();
    throw new AppError(`${what}${json.trace_id ? `  trace=${json.trace_id}` : ''}`);
  }
  return json;
}

function say(turn, id, r, extra = '') {
  if (QUIET) return;
  const v = r.verdict;
  console.log(`${turn.padEnd(6)}  ${String(id).slice(0, 8)}  ${v.score}/10 ${v.label}${extra}  trace=${r.trace_id}`);
}

/** One run: a judge call, plus appeal and final for three-turn runs. */
async function run(n) {
  const item = itemFor(n);
  let turn = 'judge';
  try {
    const judged = await post('/judge', { text: item.text });
    const id = judged.conversation_id;
    say('judge', id, judged);
    if (!isThreeTurn(n)) return;

    turn = 'appeal';
    const appealed = await post(`/judge/${encodeURIComponent(id)}/appeal`, { text: item.appeal.text });
    say('appeal', id, appealed);

    turn = 'final';
    const final = await post(`/judge/${encodeURIComponent(id)}/final`, {});
    say('final', id, final, ` ruling=${final.verdict.ruling}`);
  } catch (err) {
    if (err instanceof AppError) err.message = `${turn.padEnd(6)}  error ${err.message}`;
    throw err;
  }
}

async function runOnce() {
  const deadline = Date.now() + ONCE_TIMEOUT_MS;
  let backoff = BACKOFF_START_MS;
  for (;;) {
    try {
      await run(0);
      return 0;
    } catch (err) {
      if (!(err instanceof Unreachable)) {
        console.error(err.message);
        return 1;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        console.error(`Could not reach Roast Judge at ${BASE} (${err.message}). Is the app running? npm run dev`);
        return 1;
      }
      await sleep(Math.min(backoff, left));
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
}

async function runForever() {
  console.log(`load: sending roasts to ${BASE} every ${INTERVAL_MS} ms (seed ${SEED}, ~${THREE_TURN_SHARE * 100}% three-turn). Ctrl-C to stop.`);
  // codespace-start.sh sends SIGHUP when it restarts the app; the generator just keeps going.
  process.on('SIGHUP', () => console.log('load: got SIGHUP, carrying on'));

  let n = 0;
  let backoff = BACKOFF_START_MS;
  for (;;) {
    try {
      await run(n);
    } catch (err) {
      if (err instanceof Unreachable) {
        console.error(`load: cannot reach ${BASE} (${err.message}); retrying in ${backoff} ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        continue; // retry the same run
      }
      if (!(err instanceof AppError)) throw err; // a bug in this script: crash loudly
      console.error(err.message); // the app answered with an error: log it and move on
    }
    backoff = BACKOFF_START_MS;
    n += 1;
    await sleep(INTERVAL_MS);
  }
}

if (ONCE) process.exit(await runOnce());
await runForever();
