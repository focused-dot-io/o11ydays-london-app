'use strict';

// Phase 6: scripts/catchup.sh (`npm run catchup -- N`).
// SPEC: git fetch origin, park uncommitted work on my-work-<timestamp> only if the tree is dirty, then
// git checkout -B checkpoint-N origin/checkpoint-N. .env, .claude/settings.local.json, .gemini/.env,
// .codex-home/ gitignored so keys never get parked.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - bash, `set -euo pipefail`, operates on the repo of the current working directory.
//  - N must be one of: 0 1 2 2-cut 3 4. Missing or other -> usage message, exit 1, no git changes.
//  - Dirty = `git status --porcelain` non-empty (untracked files count). Then: create branch
//    `my-work-<YYYYMMDD-HHMMSS>` from HEAD, `git add -A`, commit
//    "Parked work before catch-up to checkpoint-N". Clean tree -> no my-work branch.
//  - Then `git checkout -B checkpoint-N origin/checkpoint-N` and print `Now on checkpoint-N`.
//  - The script uses the user's git identity; it does not set one.
//  - Then, if .dev.pid in the repo root names a live process (the Codespace's detached app), send it
//    SIGHUP and print `app: restarted on checkpoint-N`. Otherwise print a hint to restart npm run dev.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { ROOT, runBash } = require('./helpers/run-script.js');

const SCRIPT = path.join(ROOT, 'scripts', 'catchup.sh');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-catchup-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// An isolated git config: identity, no signing, no user hooks, deterministic default branch.
const gitconfig = path.join(tmp, 'gitconfig');
fs.writeFileSync(
  gitconfig,
  '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n',
);
const GIT_ENV = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let n = 0;
/** Bare origin with main and checkpoint-2 (different content), plus a fresh clone on main. */
function makeRepos() {
  n += 1;
  const base = path.join(tmp, `case-${n}`);
  const seed = path.join(base, 'seed');
  const origin = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  fs.mkdirSync(seed, { recursive: true });
  git(base, 'init', '--bare', '-b', 'main', origin);
  git(seed, 'init', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'app.txt'), 'main\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), '.env\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'main');
  git(seed, 'checkout', '-b', 'checkpoint-2');
  fs.writeFileSync(path.join(seed, 'app.txt'), 'checkpoint-2\n');
  fs.writeFileSync(path.join(seed, 'CHECKPOINT'), 'checkpoint-2\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'checkpoint-2');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', 'origin', 'main', 'checkpoint-2');
  git(base, 'clone', '-b', 'main', origin, clone);
  // A later commit on origin's checkpoint-2, so the script must fetch to see it.
  fs.writeFileSync(path.join(seed, 'app.txt'), 'checkpoint-2 v2\n');
  git(seed, 'commit', '-am', 'checkpoint-2 update');
  git(seed, 'push', 'origin', 'checkpoint-2');
  return { seed, origin, clone };
}

const catchup = (clone, args) => runBash([SCRIPT, ...args], { cwd: clone, env: GIT_ENV });
const myWork = (clone) => git(clone, 'branch', '--list', 'my-work-*', '--format=%(refname:short)').split('\n').filter(Boolean);

test('catchup 2 on a dirty tree parks the work on my-work-<timestamp> and lands on checkpoint-2', async () => {
  const { clone } = makeRepos();
  fs.writeFileSync(path.join(clone, 'app.txt'), 'my edit\n');
  fs.writeFileSync(path.join(clone, 'notes.txt'), 'untracked notes\n');
  fs.writeFileSync(path.join(clone, '.env'), 'HONEYCOMB_API_KEY=secret\n');

  const res = await catchup(clone, ['2']);
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /Now on checkpoint-2\b/, res.info);
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'checkpoint-2');
  assert.equal(git(clone, 'status', '--porcelain', '--untracked-files=all'), '', 'working tree clean (ignored .env aside)');
  assert.equal(fs.readFileSync(path.join(clone, 'app.txt'), 'utf8'), 'checkpoint-2 v2\n', 'matches the freshly fetched origin/checkpoint-2');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'origin/checkpoint-2'));

  const parked = myWork(clone);
  assert.equal(parked.length, 1, `one my-work branch: ${parked}`);
  assert.match(parked[0], /^my-work-\d{8}-\d{6}$/);
  assert.equal(git(clone, 'show', `${parked[0]}:app.txt`), 'my edit');
  assert.equal(git(clone, 'show', `${parked[0]}:notes.txt`), 'untracked notes');
  assert.match(git(clone, 'log', '-1', '--format=%s', parked[0]), /Parked work before catch-up to checkpoint-2/);
  assert.throws(() => git(clone, 'show', `${parked[0]}:.env`), 'gitignored .env is never parked');
  assert.ok(fs.existsSync(path.join(clone, '.env')), '.env survives in the working tree');
});

test('catchup 2 on a clean tree creates no my-work branch; running it again is fine', async () => {
  const { clone } = makeRepos();
  const res = await catchup(clone, ['2']);
  assert.equal(res.status, 0, res.info);
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'checkpoint-2');
  assert.deepEqual(myWork(clone), []);

  const again = await catchup(clone, ['2']);
  assert.equal(again.status, 0, again.info);
  assert.deepEqual(myWork(clone), []);
  assert.match(again.stdout, /Now on checkpoint-2\b/, again.info);
});

/** A stand-in for the detached app: writes `hup` to marker on SIGHUP, then exits. */
function fakeApp(marker) {
  const child = spawn('bash', ['-c', `trap 'echo hup > "${marker}"; exit 0' HUP; while :; do sleep 0.05; done`], { stdio: 'ignore' });
  return child;
}

test('catchup 2 with a live .dev.pid sends the app SIGHUP and says it restarted', async () => {
  const { clone } = makeRepos();
  fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), '.dev.pid\n');
  const marker = path.join(clone, '..', 'hup-marker');
  const app = fakeApp(marker);
  const exited = new Promise((resolve) => app.on('exit', resolve));
  try {
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(clone, '.dev.pid'), `${app.pid}\n`);
    const res = await catchup(clone, ['2']);
    assert.equal(res.status, 0, res.info);
    assert.match(res.stdout, /app: restarted on checkpoint-2\b/, res.info);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'hup', 'the app got SIGHUP');
    assert.deepEqual(myWork(clone), [], '.dev.pid is not parked work');
  } finally {
    app.kill('SIGKILL');
  }
});

test('catchup 2 with no live app prints the restart hint and signals nothing', async () => {
  const { clone } = makeRepos();
  fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), '.dev.pid\n');
  fs.writeFileSync(path.join(clone, '.dev.pid'), '999999\n');
  const res = await catchup(clone, ['2']);
  assert.equal(res.status, 0, res.info);
  assert.doesNotMatch(res.stdout, /app: restarted/, res.info);
  assert.match(res.stdout, /Restart npm run dev/, res.info);
});

test('catchup with a missing or unknown checkpoint -> exit 1, nothing changes', async () => {
  const { clone } = makeRepos();
  fs.writeFileSync(path.join(clone, 'notes.txt'), 'untracked\n');
  for (const args of [['9'], [], ['5'], ['checkpoint-2']]) {
    const res = await catchup(clone, args);
    assert.equal(res.status, 1, res.info);
    assert.match(res.out, /usage/i, res.info);
  }
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.deepEqual(myWork(clone), []);
  assert.ok(fs.existsSync(path.join(clone, 'notes.txt')));
});

test('catchup.sh is strict bash', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /^#!.*bash/);
  assert.match(src, /set -euo pipefail/);
});

test('.gitignore keeps keys out of parked work', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const want of ['.env', '.claude/settings.local.json', '.claude/telemetry.local.json', '.gemini/.env', '.codex-home/', '.dev.pid', '.load.pid']) {
    assert.ok(lines.includes(want), `.gitignore contains ${want}`);
  }
});
