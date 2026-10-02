'use strict';

// Test helper (no `.test.js` suffix): Docker / Compose plumbing for the Phase 8 tests.
//   dockerSkipReason()       -> null when the docker CLI is on PATH and `docker info` succeeds and
//                               SKIP_DOCKER_TESTS is not 1; otherwise a string to pass to t.skip().
//   dockerCliSkipReason()    -> same, but only needs the CLI (enough for `docker compose config`).
//   freePorts(n)             -> n distinct free TCP ports on this host.
//   composeCopy()            -> a throwaway repo copy (see repo-copy.js) WITHOUT .env and WITHOUT the
//                               node_modules symlink, so a bind mount + anonymous /app/node_modules
//                               volume behaves exactly as in a fresh clone.
//   docker(args, opts)       -> runs `docker <args>`; resolves { status, stdout, stderr, out, info }.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { copyRepo } = require('./repo-copy.js');

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

let cliReason;
function dockerCliSkipReason() {
  if (cliReason !== undefined) return cliReason;
  if (process.env.SKIP_DOCKER_TESTS === '1') cliReason = 'SKIP_DOCKER_TESTS=1';
  else if (!which('docker')) cliReason = 'docker CLI not on PATH';
  else {
    const r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 20000 });
    cliReason = r.status === 0 ? null : 'docker compose not available';
  }
  return cliReason;
}

let daemonReason;
function dockerSkipReason() {
  if (daemonReason !== undefined) return daemonReason;
  daemonReason = dockerCliSkipReason();
  if (!daemonReason) {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) daemonReason = 'docker daemon not reachable (docker info failed)';
  }
  return daemonReason;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function freePorts(n) {
  const ports = new Set();
  while (ports.size < n) ports.add(await freePort());
  return [...ports];
}

function composeCopy() {
  const dir = copyRepo();
  fs.rmSync(path.join(dir, 'node_modules'), { force: true });
  for (const f of fs.readdirSync(dir)) {
    if (f === '.env' || (f.startsWith('.env.') && f !== '.env.example')) fs.rmSync(path.join(dir, f), { force: true });
  }
  return dir;
}

function docker(args, { cwd, env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('docker', args, {
      cwd,
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
        info: `docker ${args.join(' ')}\nexit=${status} signal=${signal} ms=${ms}${error ? ` error=${error.message}` : ''}\n--- stderr ---\n${stderr.slice(-6000)}\n--- stdout ---\n${stdout.slice(-6000)}`,
      });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (status, signal) => finish(status, signal));
  });
}

module.exports = { which, dockerSkipReason, dockerCliSkipReason, freePorts, composeCopy, docker };
