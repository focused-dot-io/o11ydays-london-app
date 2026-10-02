'use strict';

// Phase 8: verify-setup.sh (the pre-workshop laptop check).
// SPEC: "Node >= 22.13, Docker daemon running, `docker compose build` (pinned node:22.22.0-alpine),
// `npm ci`, TLS reachability of api.eu1.honeycomb.io:443 (openssl or curl, no key), prints PASS or the
// first failure with the fix." "verify-setup.sh never switches branches; it prints the checkout command
// if you are on main."
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - Executable bash script at the repo root, `#!/usr/bin/env bash`, `set -uo pipefail` (no -e). It works
//    on the directory it lives in (cd "$(dirname "$0")"), whatever the caller's cwd.
//  - Checks, in this order, each printing `ok <name>` on stdout when it passes:
//      node      `node -p process.versions.node` >= 22.13 (numeric compare); also prints `node <version>`
//      docker    `docker info` succeeds; also prints `docker <version>`
//      compose   `docker compose version` succeeds
//      npm       `npm ci` succeeds                      (VERIFY_SKIP_NPM=1 skips it)
//      build     `docker compose build` succeeds        (VERIFY_SKIP_BUILD=1 skips it)
//      honeycomb TLS to api.eu1.honeycomb.io:443 via `curl -sS -o /dev/null -w '%{http_code}' https://api.eu1.honeycomb.io/`
//                (any HTTP status counts), falling back to `openssl s_client`   (VERIFY_SKIP_NET=1 skips it;
//                VERIFY_FAKE_NET_FAIL=1 forces it to fail, a test hook). The failing check may be named
//                `honeycomb` or `network`.
//    A skipped check prints `skip <name>` (not asserted) and never `FAIL`.
//  - On the first failing check: print `FAIL <name>`, then on the next line an indented `fix: <one line>`,
//    and exit 1 immediately (no later checks, no PASS). Fix texts: node -> mentions Node 22 / nvm;
//    docker -> mentions starting Docker (Desktop); honeycomb -> mentions api.eu1.honeycomb.io.
//  - On success the final stdout line is exactly `PASS` and the exit status is 0.
//  - Branch note (not a failure, before PASS): when `git rev-parse --abbrev-ref HEAD` is `main`, print
//    `You are on main; the workshop starts on checkpoint-0: npm run catchup -- 0`. Never switches branches.
//  - The node version is read with exactly `node -p process.versions.node` (the fake node below answers
//    that argv, and `-v`/`--version`; anything else runs the real node).
//  - Fake `docker` shims are used for the non-Docker cases so most of this file runs without a daemon;
//    the one real-Docker case is skipped without docker (or with SKIP_DOCKER_TESTS=1).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, runBash } = require('./helpers/run-script.js');
const { dockerSkipReason, which } = require('./helpers/docker.js');

const SCRIPT = path.join(ROOT, 'verify-setup.sh');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-verify-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SKIPS = { VERIFY_SKIP_NPM: '1', VERIFY_SKIP_BUILD: '1', VERIFY_SKIP_NET: '1' };

let n = 0;
function shimDir(shims) {
  n += 1;
  const dir = path.join(tmp, `shims-${n}`);
  fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(shims)) {
    fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}

function fakeNode(version) {
  return `if [ "$#" -eq 2 ] && [ "$1" = "-p" ] && [ "$2" = "process.versions.node" ]; then echo ${version}; exit 0; fi
if [ "$#" -eq 1 ] && { [ "$1" = "-v" ] || [ "$1" = "--version" ]; }; then echo v${version}; exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"`;
}

// A docker that "works" without a daemon: info ok, compose version ok, any version query answers 29.8.1.
const FAKE_DOCKER_OK = `case "$*" in
  "compose version"*) echo "Docker Compose version v5.5.1";;
  *--format*) echo "29.8.1";;
  info*) echo "Server Version: 29.8.1";;
  *) echo "Docker version 29.8.1, build fake";;
esac
exit 0`;

function realDockerDelegating(infoBody) {
  const real = which('docker');
  return `if [ "$1" = "info" ]; then ${infoBody}; fi
exec ${JSON.stringify(real || '/usr/local/bin/docker')} "$@"`;
}

const withPath = (dir) => `${dir}${path.delimiter}${process.env.PATH}`;
const lines = (s) => s.split(/\r?\n/).filter((l) => l.trim() !== '');
const lastLine = (s) => {
  const l = lines(s);
  return l.length ? l[l.length - 1] : '';
};

function assertFail(r, name, fixRe) {
  assert.equal(r.status, 1, r.info);
  const ls = r.out.split(/\r?\n/);
  const i = ls.findIndex((l) => new RegExp(`^FAIL (${name})\\b`).test(l));
  assert.ok(i >= 0, `no "FAIL ${name}" line:\n${r.info}`);
  const fix = ls.slice(i + 1).find((l) => l.trim() !== '');
  assert.match(fix || '', /^\s+fix: \S/, `the line after FAIL must be an indented "fix: ..." line:\n${r.info}`);
  if (fixRe) assert.match(fix, fixRe, r.info);
  assert.ok(!lines(r.stdout).includes('PASS'), `PASS printed after a failure:\n${r.info}`);
  assert.equal((r.out.match(/^FAIL /gm) || []).length, 1, 'only the first failure is reported');
}

test('verify-setup.sh exists at the repo root, is executable, bash, set -uo pipefail without -e', () => {
  assert.ok(fs.existsSync(SCRIPT), 'verify-setup.sh missing');
  assert.ok(fs.statSync(SCRIPT).mode & 0o100, 'verify-setup.sh is not executable');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.equal(src.split('\n')[0], '#!/usr/bin/env bash');
  assert.match(src, /^set -uo pipefail\s*$/m);
  assert.doesNotMatch(src, /^set -[a-z]*e/m, 'no set -e: the script reports the first failure itself');
  assert.match(src, /api\.eu1\.honeycomb\.io/);
  assert.doesNotMatch(src, /git\s+(checkout|switch)\b/, 'verify-setup never switches branches');
});

test('verify-setup.sh: with real Docker and the slow checks skipped -> ok node/docker/compose, last line PASS', { timeout: 90000 }, async (t) => {
  const reason = dockerSkipReason();
  if (reason) return t.skip(reason);
  const r = await runBash([SCRIPT], { env: SKIPS, timeoutMs: 60000 });
  assert.equal(r.status, 0, r.info);
  const out = lines(r.stdout);
  for (const ok of ['ok node', 'ok docker', 'ok compose']) assert.ok(out.includes(ok), `missing "${ok}":\n${r.info}`);
  assert.ok(out.indexOf('ok node') < out.indexOf('ok docker') && out.indexOf('ok docker') < out.indexOf('ok compose'), 'check order');
  assert.match(r.stdout, /^node v?22\.\d+\.\d+\s*$/m);
  assert.match(r.stdout, /^docker v?\d+\.\d+/m);
  assert.doesNotMatch(r.out, /^FAIL /m);
  assert.equal(lastLine(r.stdout), 'PASS', r.info);
});

test('verify-setup.sh works from another cwd (it cds to its own directory)', { timeout: 60000 }, async () => {
  const shims = shimDir({ docker: FAKE_DOCKER_OK });
  const r = await runBash([SCRIPT], { cwd: tmp, env: { ...SKIPS, PATH: withPath(shims) }, timeoutMs: 30000 });
  assert.equal(r.status, 0, r.info);
  assert.equal(lastLine(r.stdout), 'PASS', r.info);
});

for (const v of ['20.0.0', '22.12.0', '22.9.0']) {
  test(`verify-setup.sh: node ${v} -> FAIL node with a fix, exit 1, nothing after`, { timeout: 60000 }, async () => {
    const shims = shimDir({ node: fakeNode(v), docker: FAKE_DOCKER_OK });
    const r = await runBash([SCRIPT], { env: { ...SKIPS, PATH: withPath(shims) }, timeoutMs: 30000 });
    assertFail(r, 'node', /22|nvm/i);
    assert.doesNotMatch(r.stdout, /^ok docker$/m, 'stops at the first failure');
  });
}

for (const v of ['22.13.0', '22.22.0', '24.1.0']) {
  test(`verify-setup.sh: node ${v} passes the version check`, { timeout: 60000 }, async () => {
    const shims = shimDir({ node: fakeNode(v), docker: FAKE_DOCKER_OK });
    const r = await runBash([SCRIPT], { env: { ...SKIPS, PATH: withPath(shims) }, timeoutMs: 30000 });
    assert.equal(r.status, 0, r.info);
    assert.ok(lines(r.stdout).includes('ok node'), r.info);
    assert.equal(lastLine(r.stdout), 'PASS', r.info);
  });
}

test('verify-setup.sh: docker info failing -> FAIL docker with a fix to start Docker', { timeout: 60000 }, async () => {
  const shims = shimDir({ docker: realDockerDelegating('echo "Cannot connect to the Docker daemon" >&2; exit 1') });
  const r = await runBash([SCRIPT], { env: { ...SKIPS, PATH: withPath(shims) }, timeoutMs: 30000 });
  assert.ok(lines(r.stdout).includes('ok node'), r.info);
  assertFail(r, 'docker', /docker/i);
});

test('verify-setup.sh: no docker on PATH at all -> FAIL docker', { timeout: 60000 }, async () => {
  // A PATH with bash, git, coreutils etc. but no docker: copy nothing, just hide docker's directory.
  const dockerDir = which('docker') && path.dirname(which('docker'));
  const filtered = process.env.PATH.split(path.delimiter).filter((d) => d && d !== dockerDir);
  const shims = shimDir({ node: fakeNode('22.22.0') });
  const PATH = [shims, ...filtered].join(path.delimiter);
  const probe = await runBash(['-c', 'command -v docker || true'], { env: { PATH } });
  if (probe.stdout.trim()) return; // docker lives in a shared bin dir we cannot hide; covered by the case above
  const r = await runBash([SCRIPT], { env: { ...SKIPS, PATH }, timeoutMs: 30000 });
  assertFail(r, 'docker', /docker/i);
});

test('verify-setup.sh: Honeycomb unreachable (VERIFY_FAKE_NET_FAIL=1) -> FAIL honeycomb naming the endpoint', { timeout: 60000 }, async () => {
  const shims = shimDir({ docker: FAKE_DOCKER_OK });
  const env = { VERIFY_SKIP_NPM: '1', VERIFY_SKIP_BUILD: '1', VERIFY_FAKE_NET_FAIL: '1', PATH: withPath(shims) };
  const r = await runBash([SCRIPT], { env, timeoutMs: 30000 });
  for (const ok of ['ok node', 'ok docker', 'ok compose']) assert.ok(lines(r.stdout).includes(ok), r.info);
  assertFail(r, 'honeycomb|network', /api\.eu1\.honeycomb\.io/);
});

// A scratch git repo holding a copy of the script (and package.json), on a given branch.
function gitCase(branch) {
  n += 1;
  const dir = path.join(tmp, `git-${n}`);
  fs.mkdirSync(dir);
  fs.copyFileSync(SCRIPT, path.join(dir, 'verify-setup.sh'));
  fs.chmodSync(path.join(dir, 'verify-setup.sh'), 0o755);
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
      encoding: 'utf8',
    }).trim();
  git('init', '-q', '-b', branch);
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return { dir, git };
}

test('verify-setup.sh on main: prints the catch-up command, still PASSes, does not switch branch', { timeout: 60000 }, async () => {
  const { dir, git } = gitCase('main');
  const shims = shimDir({ docker: FAKE_DOCKER_OK });
  const r = await runBash([path.join(dir, 'verify-setup.sh')], { cwd: dir, env: { ...SKIPS, PATH: withPath(shims) }, timeoutMs: 30000 });
  assert.equal(r.status, 0, r.info);
  assert.match(r.out, /checkpoint-0/, r.info);
  assert.ok(r.out.includes('npm run catchup -- 0'), r.info);
  assert.equal(lastLine(r.stdout), 'PASS', r.info);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git('status', '--porcelain'), '');
});

test('verify-setup.sh on checkpoint-0: no catch-up note', { timeout: 60000 }, async () => {
  const { dir, git } = gitCase('checkpoint-0');
  const shims = shimDir({ docker: FAKE_DOCKER_OK });
  const r = await runBash([path.join(dir, 'verify-setup.sh')], { cwd: dir, env: { ...SKIPS, PATH: withPath(shims) }, timeoutMs: 30000 });
  assert.equal(r.status, 0, r.info);
  assert.ok(!r.out.includes('npm run catchup'), r.info);
  assert.equal(lastLine(r.stdout), 'PASS', r.info);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'checkpoint-0');
});
