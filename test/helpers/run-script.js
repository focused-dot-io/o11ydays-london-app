'use strict';

// Test helper (no `.test.js` suffix): run a repo script as a child process with a controlled env
// (only PATH and HOME inherited, so no .env, OTEL_* or keys leak in) and collect its output.
//   runNode(['scripts/x.mjs', ...args], { env, cwd, timeoutMs })  -> node <args>
//   runBash(['scripts/x.sh', ...args],  { env, cwd, timeoutMs })  -> bash <args>
// Both resolve { status, signal, stdout, stderr, out (both), ms, info } and never reject; the child
// is SIGKILLed after timeoutMs (default 15000) so a hanging script fails the test instead of hanging it.

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

function baseEnv(env) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...env };
}

function run(cmd, args, { env = {}, cwd = ROOT, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: baseEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (status, signal, error) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      resolve({
        status,
        signal,
        stdout,
        stderr,
        out: stdout + stderr,
        ms,
        info: `${cmd} ${args.join(' ')}\nexit=${status} signal=${signal} ms=${ms}${error ? ` error=${error.message}` : ''}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
      });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (status, signal) => finish(status, signal));
  });
}

const runNode = (args, opts) => run(process.execPath, args, opts);
const runBash = (args, opts) => run('bash', args, opts);

/** Spawn a long-running script; returns { child, out() , exited } for manual control. */
function spawnLong(cmd, args, { env = {}, cwd = ROOT } = {}) {
  const child = spawn(cmd, args, { cwd, env: baseEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, stdout: '', stderr: '', exited: null };
  child.stdout.on('data', (d) => {
    state.stdout += d;
  });
  child.stderr.on('data', (d) => {
    state.stderr += d;
  });
  state.exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      state.exited = { code, signal };
      resolve(state.exited);
    });
  });
  state.info = () => `exited=${JSON.stringify(state.exited)}\n--- stderr ---\n${state.stderr.slice(-4000)}\n--- stdout ---\n${state.stdout.slice(-4000)}`;
  state.kill = async (signal = 'SIGTERM') => {
    if (state.exited) return state.exited;
    child.kill(signal);
    const t = setTimeout(() => {
      if (!state.exited) child.kill('SIGKILL');
    }, 5000);
    const r = await state.exitPromise;
    clearTimeout(t);
    return r;
  };
  return state;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return Boolean(await predicate());
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ROOT, runNode, runBash, spawnLong, sleep, waitFor, isAlive };
