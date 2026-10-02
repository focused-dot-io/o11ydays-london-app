'use strict';

// Test helper (no `.test.js` suffix): reading and applying the checkpoint overlays in
// checkpoints/<name>/, and diffing an overlay file against main's copy of it.
//
// CONTRACT (ASSUMPTIONS beyond SPEC.md; the implementer must follow these):
//   - An overlay directory holds CHECKPOINT (`<name>\n`) plus ONLY the files that differ from main:
//       checkpoint-0, checkpoint-1, checkpoint-2      -> CHECKPOINT, src/agent.js, src/telemetry.js
//       checkpoint-2-cut, checkpoint-3, checkpoint-4  -> CHECKPOINT, src/agent.js
//     Nothing else (no README, no .gitkeep). main has no overlay directory.
//   - Applying an overlay = copying each of its files over the same path in the tree.
//   - A "TODO block" is a line containing `TODO(module-` plus the contiguous `//` comment lines
//     directly below it; that is where the attendee-facing hint lives.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { matchBrace } = require('./blank-spans.js');

const ROOT = path.join(__dirname, '..', '..');
const CHECKPOINTS_DIR = path.join(ROOT, 'checkpoints');

const FULL = ['CHECKPOINT', 'src/agent.js', 'src/telemetry.js'];
const AGENT_ONLY = ['CHECKPOINT', 'src/agent.js'];
const EXPECTED_FILES = {
  'checkpoint-0': FULL,
  'checkpoint-1': FULL,
  'checkpoint-2': FULL,
  'checkpoint-2-cut': AGENT_ONLY,
  'checkpoint-3': AGENT_ONLY,
  'checkpoint-4': AGENT_ONLY,
};
const NAMES = Object.keys(EXPECTED_FILES);
const OVERLAY_SOURCE_FILES = ['src/agent.js', 'src/telemetry.js'];

const overlayDir = (name) => path.join(CHECKPOINTS_DIR, name);

/** Every file under checkpoints/<name>/, as sorted POSIX-style relative paths. */
function listOverlayFiles(name) {
  const base = overlayDir(name);
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(base, p).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
}

function readOverlay(name, rel) {
  return fs.readFileSync(path.join(overlayDir(name), rel), 'utf8');
}

/** The content a checkpoint branch ships for `rel`: the overlay's copy, else main's. */
function effectiveFile(name, rel) {
  const p = path.join(overlayDir(name), rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Copies checkpoints/<name>/* over the tree rooted at `dir`. */
function applyOverlay(dir, name) {
  for (const rel of listOverlayFiles(name)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(overlayDir(name), rel), dest);
  }
}

/**
 * `git diff --no-index -U3 a b` parsed into hunks: [{ header, removed: string[], added: string[] }].
 * Context lines are dropped (they are identical on both sides).
 */
function diffHunks(a, b) {
  const r = spawnSync(
    'git',
    ['-c', 'core.quotepath=off', 'diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', a, b],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed (${r.status}): ${r.stderr}`);
  const hunks = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@')) {
      cur = { header: line, removed: [], added: [] };
      hunks.push(cur);
    } else if (cur && line.startsWith('-')) cur.removed.push(line.slice(1));
    else if (cur && line.startsWith('+')) cur.added.push(line.slice(1));
  }
  return hunks;
}

const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

/** Non-blank, non-comment lines, trimmed, with any trailing `// comment` removed. */
function codeLines(src) {
  return src
    .split('\n')
    .filter((l) => !isComment(l))
    .map((l) => l.replace(/\s+\/\/.*$/, '').trim())
    .filter((l) => l !== '');
}

/** TODO blocks: the `TODO(module-` line plus the contiguous comment lines below it, joined. */
function todoBlocks(src) {
  const lines = src.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('TODO(module-')) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && isComment(lines[j]) && !lines[j].includes('TODO(module-'); j++) block.push(lines[j]);
    blocks.push(block.join('\n'));
  }
  return blocks;
}

/** The body text (between the braces, exclusive) of `function <fnName>(...) { ... }`. */
function functionBody(src, fnName) {
  const sig = `function ${fnName}(`;
  const at = src.indexOf(sig);
  if (at === -1) throw new Error(`\`${sig}\` not found`);
  let i = at + sig.length;
  let parens = 1;
  for (; i < src.length && parens > 0; i++) {
    if (src[i] === '(') parens++;
    if (src[i] === ')') parens--;
  }
  const open = src.indexOf('{', i);
  const close = matchBrace(src, open);
  return src.slice(open + 1, close);
}

module.exports = {
  ROOT,
  CHECKPOINTS_DIR,
  EXPECTED_FILES,
  NAMES,
  OVERLAY_SOURCE_FILES,
  overlayDir,
  listOverlayFiles,
  readOverlay,
  effectiveFile,
  applyOverlay,
  diffHunks,
  codeLines,
  todoBlocks,
  functionBody,
};
