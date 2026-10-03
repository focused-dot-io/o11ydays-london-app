'use strict';

// The engine behind `npm run verify` and `npm run check-spans`.
//
//   1. fork the pub guide and the replay model as child processes on free ports (children, not
//      in-process, so the app's SDK never instruments them)
//   2. load src/telemetry.js with the in-memory exporter, THEN the app, and serve it on a free port
//   3. POST judge -> appeal -> final (always the replay model), collect each request's trace
//   4. run a named expectation set from scripts/expectations/ and print one line per check
//
// It never throws: every failure (unknown set, a child that will not start, a crash) ends in a
// `FAIL <set>: <message>` line and exit code 1, without a stack trace. Children are always killed.
//
// Only node built-ins are required at the top of this file: telemetry has to load before express,
// openai or http are required, so those come later, inside run().

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const EXPECTATIONS = path.join(ROOT, 'scripts', 'expectations');
const REPLAY_HEADERS = { 'x-roastjudge-model': 'replay' };
const FINISH_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 25000;

const children = [];

function killChildren() {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        c.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}
process.on('exit', killChildren);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first line of an error's message: no stack traces in this CLI's output. */
function oneLine(err) {
  const msg = err && err.message ? err.message : String(err);
  return (msg.split(/\r?\n/).find((l) => l.trim() !== '') || 'unknown error').trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startChild(label, script, env) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const state = { label, child, out: '', exited: null };
  child.stdout.on('data', (d) => {
    state.out += d;
  });
  child.stderr.on('data', (d) => {
    state.out += d;
  });
  child.on('exit', (code, signal) => {
    state.exited = { code, signal };
  });
  child.on('error', (err) => {
    state.exited = { error: err.message };
  });
  return state;
}

async function waitHealthy(state, url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) {
      const tail = state.out.trim().split(/\r?\n/).filter((l) => !/^\s+at\s/.test(l)).slice(-1)[0] || '';
      throw new Error(`${state.label} exited before it was healthy${tail ? ` (${tail.trim()})` : ''}`);
    }
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(50);
  }
  throw new Error(`${state.label} did not become healthy at ${url}`);
}

/** Loads scripts/expectations/<set>.js, or throws a one-line error. */
function loadSet(set) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(set)) throw new Error(`unknown expectation set "${set}"`);
  const file = path.join(EXPECTATIONS, `${set}.js`);
  if (!fs.existsSync(file)) {
    const known = fs
      .readdirSync(EXPECTATIONS)
      .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
      .map((f) => f.slice(0, -3));
    throw new Error(`unknown expectation set "${set}" (known: ${known.join(', ')})`);
  }
  const checks = require(file);
  if (!Array.isArray(checks) || checks.length === 0) throw new Error(`scripts/expectations/${set}.js does not export a list of checks`);
  return checks;
}

/** Runs the app with the three turns and returns ctx.turns. */
async function collectTurns() {
  const [pubPort, replayPort, appPort] = [await freePort(), await freePort(), await freePort()];

  const pub = startChild('pub-guide', 'services/pub-guide/server.js', { PORT: String(pubPort) });
  const replay = startChild('model-replay', 'services/model-replay/server.js', {
    PORT: String(replayPort),
    REPLAY_LATENCY_SCALE: '0',
    REPLAY_FAIL_EVERY: '0',
  });
  await Promise.all([
    waitHealthy(pub, `http://127.0.0.1:${pubPort}/healthz`),
    waitHealthy(replay, `http://127.0.0.1:${replayPort}/healthz`),
  ]);

  process.env.PUB_GUIDE_URL = `http://127.0.0.1:${pubPort}`;
  process.env.REPLAY_URL = `http://127.0.0.1:${replayPort}/v1`;
  delete process.env.ROASTJUDGE_MODEL;

  // Telemetry first, so the instrumentations patch http/express/openai before the app loads them.
  const telemetry = require(path.join(ROOT, 'src', 'telemetry.js'));
  if (!telemetry.memoryExporter) throw new Error('src/telemetry.js did not create the in-memory exporter');
  const { context, trace } = require('@opentelemetry/api');
  const { suppressTracing } = require('@opentelemetry/core');
  // Capture the real model response independently of the attendee's span attributes.
  // This is verification-only; content capture stays off and nothing is exported remotely.
  // Must run before server.js is required: it destructures getClient at load time.
  const modelToolCalls = new Map();
  const modelClient = require(path.join(ROOT, 'src', 'model-client.js'));
  const getClient = modelClient.getClient;
  modelClient.getClient = (...args) => {
    const client = getClient(...args);
    const create = client.responses.create.bind(client.responses);
    client.responses.create = async (...requestArgs) => {
      const traceId = trace.getSpan(context.active())?.spanContext().traceId;
      const response = await create(...requestArgs);
      const calls = response.output.filter((item) => item.type === 'function_call')
        .map((item) => ({ id: item.call_id, name: item.name }));
      modelToolCalls.set(traceId, [...(modelToolCalls.get(traceId) || []), ...calls]);
      return response;
    };
    return client;
  };
  const { createApp } = require(path.join(ROOT, 'src', 'server.js'));
  const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'replay', 'corpus.json'), 'utf8'));
  const item = corpus[0];

  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(appPort, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  try {
    const base = `http://127.0.0.1:${appPort}`;
    // Our own requests must not be traced, or their CLIENT spans would become the trace roots.
    const post = (urlPath, body) =>
      context.with(suppressTracing(context.active()), async () => {
        const res = await fetch(`${base}${urlPath}`, {
          method: 'POST',
          headers: { ...REPLAY_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = {};
        }
        if (res.status !== 200) {
          throw new Error(`POST ${urlPath.replace(/\/judge\/[^/]+\//, '/judge/:id/')} returned ${res.status} ${json.error || text.slice(0, 80)}`);
        }
        const traceId = res.headers.get('x-trace-id') || json.trace_id;
        if (!traceId) throw new Error(`POST ${urlPath} returned no x-trace-id header`);
        return { json, traceId };
      });

    const judge = await post('/judge', { text: item.text });
    const id = encodeURIComponent(judge.json.conversation_id);
    const appeal = await post(`/judge/${id}/appeal`, { text: item.appeal.text });
    const final = await post(`/judge/${id}/final`, {});

    const turns = [
      { name: 'judge', traceId: judge.traceId },
      { name: 'appeal', traceId: appeal.traceId },
      { name: 'final', traceId: final.traceId },
    ];

    const flush = async () => {
      const tp = trace.getTracerProvider();
      const real = typeof tp.getDelegate === 'function' ? tp.getDelegate() : tp;
      if (real && typeof real.forceFlush === 'function') await real.forceFlush();
    };
    const spansOf = (traceId) => telemetry.memoryExporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
    const isRoot = (s) => s.kind === 1 && !(s.parentSpanContext && s.parentSpanContext.spanId) && !s.parentSpanId;

    // The SERVER span ends just after the response is written: wait for every trace's root.
    const deadline = Date.now() + FINISH_TIMEOUT_MS;
    for (;;) {
      await flush();
      if (turns.every((t) => spansOf(t.traceId).some(isRoot)) || Date.now() > deadline) break;
      await sleep(25);
    }
    await sleep(20);
    await flush();

    return turns.map((t) => ({ name: t.name, spans: spansOf(t.traceId), modelToolCalls: modelToolCalls.get(t.traceId) || [] }));
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
}

function runChecks(checks, ctx) {
  return checks.map((c) => {
    let result;
    try {
      result = c.check(ctx);
    } catch (err) {
      result = `check threw: ${oneLine(err)}`;
    }
    if (result !== true && !(typeof result === 'string' && result.length > 0)) result = `check returned ${JSON.stringify(result)}`;
    return { name: c.name, ok: result === true, reason: result === true ? '' : oneLine({ message: result }) };
  });
}

/**
 * Runs one expectation set end to end and exits the process.
 * @param {object} opts
 * @param {string} opts.set            expectation set name
 * @param {string} [opts.header]       first line to print
 * @param {string[]} [opts.expectedSpans]  span names to diff against the judge turn ("missing span `x`")
 * @param {(missing: string[]) => string[]} [opts.hint]  extra lines printed before the FAIL line
 */
async function main({ set, header, expectedSpans, hint }) {
  const label = set || '(none)';
  let exitCode = 1;
  const out = (line) => process.stdout.write(`${line}\n`);

  // No stack traces from anything the app logs while we run it.
  console.error = (...args) => {
    const first = args.map((a) => (a instanceof Error ? oneLine(a) : String(a))).join(' ');
    process.stderr.write(`${oneLine({ message: first })}\n`);
  };
  // Node's own ExperimentalWarning (node:sqlite) is noise here; print other warnings on one line.
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w && w.name !== 'ExperimentalWarning') process.stderr.write(`warning: ${oneLine(w)}\n`);
  });
  const crash = (err) => {
    out(`FAIL ${label}: ${oneLine(err)}`);
    killChildren();
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  const timer = setTimeout(() => crash(new Error(`timed out after ${OVERALL_TIMEOUT_MS / 1000}s`)), OVERALL_TIMEOUT_MS);
  timer.unref();

  try {
    if (header) out(header);
    if (!set) throw new Error('no expectation set: pass one as an argument or put it in CHECKPOINT');
    const checks = loadSet(set);

    process.env.ROASTJUDGE_EXPORTER = 'memory';
    process.env.SEAT = process.env.SEAT || '0';

    const turns = await collectTurns();
    const ctx = { checkpoint: set, turns };

    let missing = [];
    if (expectedSpans) {
      const present = new Set(turns[0].spans.map((s) => s.name));
      missing = expectedSpans.filter((n) => !present.has(n));
      for (const n of missing) out(`missing span \`${n}\``);
    }

    const results = runChecks(checks, ctx);
    for (const r of results) out(r.ok ? `ok ${r.name}` : `FAIL ${r.name}: ${r.reason}`);
    const failed = results.filter((r) => !r.ok).length;
    if (failed === 0) {
      out(`PASS ${set}: ${results.length} checks`);
      exitCode = 0;
    } else {
      if (hint) for (const line of hint(missing)) out(line);
      out(`FAIL ${set}: ${failed} of ${results.length} checks failed`);
    }
  } catch (err) {
    out(`FAIL ${label}: ${oneLine(err)}`);
    exitCode = 1;
  } finally {
    killChildren();
  }
  process.exit(exitCode);
}

/** The trimmed contents of CHECKPOINT at the repo root, or '' when it is missing. */
function readCheckpoint() {
  try {
    return fs.readFileSync(path.join(ROOT, 'CHECKPOINT'), 'utf8').trim();
  } catch {
    return '';
  }
}

module.exports = { main, readCheckpoint, ROOT };
