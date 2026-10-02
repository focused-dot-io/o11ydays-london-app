'use strict';

// Phase 7: scripts/build-checkpoints.sh, the maintainer-only generator of the checkpoint branches,
// and docs/checkpoints.md.
//
// SPEC: branches are generated from main in a throwaway `git worktree` (maintainer-only script;
// requires git >= 2.17, stated in the script header and docs/checkpoints.md, and the script exits
// with that message if the version is older): copy checkpoints/<name>/ overlay files over the tree,
// delete checkpoints/, commit, `push --force-with-lease`.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - CLI: `scripts/build-checkpoints.sh [--source <ref>] [--remote <name>] [--no-push] [--only <name>]`
//      --source  commit-ish to build from (default HEAD); every branch = that commit + ONE commit
//      --remote  remote to push to (default origin)
//      --no-push build the branches as LOCAL branches (refs/heads/<name>) and print what would be
//                pushed (each branch name appears in the output); nothing is pushed
//      --only    build (and push) just that one checkpoint
//    Without --no-push it pushes every built branch to <remote> with `--force-with-lease`; a second
//    run in the same clone succeeds (idempotent) and leaves the branches correct.
//  - Branch names = overlay names: checkpoint-0, checkpoint-1, checkpoint-2, checkpoint-2-cut,
//    checkpoint-3, checkpoint-4. Each branch's tip is a single commit whose parent is the source
//    commit and whose subject contains the checkpoint name. The tree is the source tree with the
//    overlay's files copied over and checkpoints/ deleted; every other path is byte-identical.
//  - It works from any cwd inside the repo, needs no network beyond the remote, and leaves the
//    clone as it found it: same branch, same HEAD, clean status, `git worktree list` back to one
//    entry (the throwaway worktree is removed even on success).
//  - Git version guard: it reads `git --version`; below 2.17 it exits 1 with a message containing
//    `2.17`, before creating any branch.
//  - Script file: bash shebang, `set -euo pipefail`, header comment saying it is maintainer-only
//    and requires git >= 2.17. docs/checkpoints.md mentions 2.17 and lists the six branches and main.
//  - The script commits with whatever identity git is configured with (the test sets one via
//    GIT_AUTHOR_* / GIT_COMMITTER_* and isolates global config with GIT_CONFIG_GLOBAL=/dev/null).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ov = require('./helpers/checkpoint-overlays.js');

const { ROOT, NAMES } = ov;
const SCRIPT_REL = 'scripts/build-checkpoints.sh';
const SCRIPT = path.join(ROOT, SCRIPT_REL);
const DOC = path.join(ROOT, 'docs', 'checkpoints.md');
const OVERLAY_PATHS = new Set(['CHECKPOINT', ...ov.OVERLAY_SOURCE_FILES]);
const REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

const temps = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  temps.push(d);
  return d;
}

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Checkpoint Test',
  GIT_AUTHOR_EMAIL: 'checkpoint-test@example.invalid',
  GIT_COMMITTER_NAME: 'Checkpoint Test',
  GIT_COMMITTER_EMAIL: 'checkpoint-test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

/** Runs the clone's copy of the script asynchronously; resolves { status, stdout, stderr, out, info }. */
function runScript(clone, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(clone, SCRIPT_REL), ...args], {
      cwd: clone,
      env: { ...GIT_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout,
        stderr,
        out: stdout + stderr,
        info: `build-checkpoints.sh ${args.join(' ')}\nexit=${status} signal=${signal}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
      });
    });
  });
}

/**
 * A fresh git repo holding the CURRENT working tree (tracked + untracked, not ignored) as one commit
 * on `main`, with a bare repo as `origin` that already has main. Independent of what is committed.
 */
function fixture() {
  const base = tmp('roastjudge-build-');
  const bare = path.join(base, 'origin.git');
  const clone = path.join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(clone);
  git(clone, 'init', '-q', '-b', 'main');
  const files = git(ROOT, 'ls-files', '-z', '-co', '--exclude-standard').split('\0').filter(Boolean);
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src) || fs.lstatSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(clone, rel));
  }
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '--no-verify', '-m', 'main');
  git(clone, 'remote', 'add', 'origin', bare);
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'fetch', '-q', 'origin');
  return { base, bare, clone };
}

/** path -> blob id for every file in <rev>'s tree. */
function treeMap(repo, rev) {
  const map = new Map();
  for (const line of git(repo, 'ls-tree', '-r', rev).split('\n').filter(Boolean)) {
    const [meta, p] = line.split('\t');
    map.set(p, meta.split(' ')[2]);
  }
  return map;
}

const branchesIn = (repo) =>
  git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .filter(Boolean)
    .sort();

/** Asserts <branch> in <repo> is exactly the overlay applied on <sourceSha>. */
function assertBranch(repo, branch, sourceSha) {
  assert.equal(git(repo, 'rev-parse', `${branch}^`).trim(), sourceSha, `${branch}'s parent is the source commit`);
  assert.equal(git(repo, 'rev-list', '--count', `${sourceSha}..${branch}`).trim(), '1', `${branch} is one commit on top`);
  assert.ok(git(repo, 'log', '-1', '--format=%s', branch).includes(branch), `${branch}'s commit subject names it`);
  assert.equal(git(repo, 'show', `${branch}:CHECKPOINT`), `${branch}\n`);
  for (const rel of ov.OVERLAY_SOURCE_FILES) {
    assert.equal(git(repo, 'show', `${branch}:${rel}`), ov.effectiveFile(branch, rel), `${branch}:${rel}`);
  }
  const main = treeMap(repo, sourceSha);
  const tip = treeMap(repo, branch);
  assert.ok(![...tip.keys()].some((p) => p.startsWith('checkpoints/')), `${branch} has no checkpoints/ paths`);
  const expectedPaths = [...main.keys()].filter((p) => !p.startsWith('checkpoints/')).sort();
  assert.deepEqual([...tip.keys()].sort(), expectedPaths, `${branch} has main's paths minus checkpoints/`);
  for (const p of expectedPaths) {
    if (OVERLAY_PATHS.has(p)) continue;
    assert.equal(tip.get(p), main.get(p), `${branch}:${p} is byte-identical to the source`);
  }
}

function assertCloneUntouched(clone, headBefore) {
  assert.equal(git(clone, 'branch', '--show-current').trim(), 'main', 'still on main');
  assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), headBefore, 'HEAD unchanged');
  assert.equal(git(clone, 'status', '--porcelain'), '', 'working tree clean');
  assert.equal(git(clone, 'worktree', 'list').split('\n').filter(Boolean).length, 1, 'no worktree left behind');
}

// ---------------------------------------------------------------------------------------------
// Static checks

test('scripts/build-checkpoints.sh: executable bash, strict mode, maintainer-only header naming git 2.17', () => {
  assert.ok(fs.existsSync(SCRIPT), `${SCRIPT_REL} exists`);
  assert.ok(fs.statSync(SCRIPT).mode & 0o111, 'is executable');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const lines = src.split('\n');
  assert.match(lines[0], /^#!.*\bbash\b/, 'bash shebang');
  assert.ok(lines.some((l) => l.trim() === 'set -euo pipefail'), 'set -euo pipefail');
  const header = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith('#') || l.trim() === '') header.push(l);
    else break;
  }
  const h = header.join('\n');
  assert.match(h, /maintainer/i, 'header says maintainer-only');
  assert.match(h, /2\.17/, 'header states git >= 2.17');
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n: ${r.stderr}`);
});

test('docs/checkpoints.md: mentions git 2.17 and lists every branch plus main', () => {
  assert.ok(fs.existsSync(DOC), 'docs/checkpoints.md exists');
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /2\.17/);
  for (const b of [...NAMES, 'main']) assert.match(doc, new RegExp(`\`${b}\``), `lists \`${b}\``);
});

// ---------------------------------------------------------------------------------------------
// Git version guard

test('git older than 2.17: exits 1 naming 2.17 and builds nothing', async () => {
  assert.ok(fs.existsSync(SCRIPT), `${SCRIPT_REL} exists`);
  const { clone, base } = fixture();
  const bin = path.join(base, 'fake-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "git version 2.16.0"; exit 0; fi\nexec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );
  const before = git(clone, 'rev-parse', 'HEAD').trim();
  const r = await runScript(clone, ['--no-push'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(r.status, 1, r.info);
  assert.match(r.out, /2\.17/, r.info);
  assert.deepEqual(branchesIn(clone), ['main'], 'no branch created');
  assertCloneUntouched(clone, before);
});

// ---------------------------------------------------------------------------------------------
// End to end against a local bare remote (no network)

test('push mode: builds and pushes all six branches; rerun is idempotent; --only touches one branch', async () => {
  assert.ok(fs.existsSync(SCRIPT), `${SCRIPT_REL} exists`);
  const { clone, bare } = fixture();
  const source = git(clone, 'rev-parse', 'HEAD').trim();

  const first = await runScript(clone, ['--source', 'HEAD']);
  assert.equal(first.status, 0, first.info);
  assert.deepEqual(branchesIn(bare), [...NAMES, 'main'].sort(), `bare remote branches\n${first.info}`);
  for (const name of NAMES) assertBranch(bare, name, source);
  assertCloneUntouched(clone, source);

  // Second run: --force-with-lease succeeds, branches still correct.
  const second = await runScript(clone, ['--source', 'HEAD']);
  assert.equal(second.status, 0, second.info);
  for (const name of NAMES) assertBranch(bare, name, source);
  assertCloneUntouched(clone, source);

  // New commit on main, then --only checkpoint-3: only that branch moves.
  const tipsBefore = Object.fromEntries(NAMES.map((n) => [n, git(bare, 'rev-parse', n).trim()]));
  fs.appendFileSync(path.join(clone, 'README.md'), '\nA maintainer edit.\n');
  git(clone, 'commit', '-q', '--no-verify', '-am', 'edit README');
  git(clone, 'push', '-q', 'origin', 'main');
  const source2 = git(clone, 'rev-parse', 'HEAD').trim();
  const only = await runScript(clone, ['--only', 'checkpoint-3']);
  assert.equal(only.status, 0, only.info);
  assertBranch(bare, 'checkpoint-3', source2);
  assert.match(git(bare, 'show', 'checkpoint-3:README.md'), /A maintainer edit\./);
  for (const name of NAMES.filter((n) => n !== 'checkpoint-3')) {
    assert.equal(git(bare, 'rev-parse', name).trim(), tipsBefore[name], `${name} untouched by --only checkpoint-3`);
  }
  assertCloneUntouched(clone, source2);
});

test('--no-push: builds local branches, prints them, pushes nothing', async () => {
  assert.ok(fs.existsSync(SCRIPT), `${SCRIPT_REL} exists`);
  const { clone, bare } = fixture();
  const source = git(clone, 'rev-parse', 'HEAD').trim();
  const r = await runScript(clone, ['--no-push', '--source', 'main']);
  assert.equal(r.status, 0, r.info);
  assert.deepEqual(branchesIn(bare), ['main'], 'nothing pushed');
  assert.deepEqual(branchesIn(clone), [...NAMES, 'main'].sort(), 'local branches built');
  for (const name of NAMES) {
    assertBranch(clone, name, source);
    assert.ok(r.out.includes(name), `output names ${name}\n${r.info}`);
  }
  assertCloneUntouched(clone, source);
});
