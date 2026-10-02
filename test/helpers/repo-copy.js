'use strict';

// Test helper (no `.test.js` suffix): a throwaway copy of the repo in the OS temp dir, minus
// .git and node_modules, with node_modules symlinked back to the real one. Used to run the
// verify / check-spans CLIs against edited trees (a different CHECKPOINT file, blanked spans).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git']);

function copyRepo() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-copy-'));
  for (const entry of fs.readdirSync(ROOT)) {
    if (SKIP.has(entry)) continue;
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), {
      recursive: true,
      filter: (src) => !src.split(path.sep).some((part) => SKIP.has(part)),
    });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

function removeCopy(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

/** Runs `node <script> [...args]` in `cwd` with only PATH and HOME in the env. */
function runNode(cwd, script, args = [], timeout = 30000) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: 'utf8',
    timeout,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  return {
    status: r.status,
    signal: r.signal,
    error: r.error,
    stdout,
    stderr,
    lines,
    last: lines.length ? lines[lines.length - 1] : '',
    describe: () => `exit=${r.status} signal=${r.signal}${r.error ? ` error=${r.error.message}` : ''}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
  };
}

/** True when the text looks like an uncaught error's stack dump (`    at fn (file:line:col)`). */
function hasStackTrace(text) {
  return /^\s+at\s.*:\d+:\d+\)?\s*$/m.test(text);
}

module.exports = { ROOT, copyRepo, removeCopy, runNode, hasStackTrace };
