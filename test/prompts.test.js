'use strict';

// Phase 4: src/prompts.js, the runtime prompt switch.
// SPEC: exports { getVersion(), setVersion(v), getPrompt(version?) }; v in v1|v2, default v1,
// throws on other values. Prompts live in prompts/roast-judge.v1.md|v2.md (first line = marker).
// ASSUMPTIONS (beyond SPEC.md):
//  - getPrompt(version) returns the file content exactly as on disk (utf8), so the replay engine
//    sees the marker line. getPrompt() with no argument uses getVersion().
//  - setVersion returns nothing in particular; a rejected setVersion leaves the version unchanged.
//  - getPrompt('v3') throws.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = {
  v1: fs.readFileSync(path.join(ROOT, 'prompts', 'roast-judge.v1.md'), 'utf8'),
  v2: fs.readFileSync(path.join(ROOT, 'prompts', 'roast-judge.v2.md'), 'utf8'),
};
const MARKER = { v1: '<!-- roast-judge prompt v1 -->', v2: '<!-- roast-judge prompt v2 -->' };

const load = () => require('../src/prompts.js');

afterEach(() => {
  try {
    load().setVersion('v1');
  } catch {
    // module missing: the test itself already failed
  }
});

test('prompts: getVersion() defaults to v1', () => {
  assert.equal(load().getVersion(), 'v1');
});

test('prompts: setVersion(v2) switches; setVersion(v1) switches back', () => {
  const p = load();
  p.setVersion('v2');
  assert.equal(p.getVersion(), 'v2');
  p.setVersion('v1');
  assert.equal(p.getVersion(), 'v1');
});

test('prompts: setVersion rejects anything but v1|v2 and keeps the current version', () => {
  const p = load();
  p.setVersion('v2');
  for (const bad of ['v3', 'V1', '', undefined, null, 1]) {
    assert.throws(() => p.setVersion(bad), `setVersion(${JSON.stringify(bad)}) should throw`);
  }
  assert.equal(p.getVersion(), 'v2');
});

test('prompts: getPrompt() returns the current version file, first line is the marker', () => {
  const p = load();
  const v1 = p.getPrompt();
  assert.equal(v1, FILE.v1);
  assert.equal(v1.split('\n')[0].trim(), MARKER.v1);
  p.setVersion('v2');
  const v2 = p.getPrompt();
  assert.equal(v2, FILE.v2);
  assert.equal(v2.split('\n')[0].trim(), MARKER.v2);
});

test('prompts: getPrompt(version) is explicit regardless of the current version', () => {
  const p = load();
  p.setVersion('v2');
  assert.equal(p.getPrompt('v1'), FILE.v1);
  assert.equal(p.getPrompt('v2'), FILE.v2);
  assert.notEqual(p.getPrompt('v1'), p.getPrompt('v2'));
  assert.throws(() => p.getPrompt('v3'));
});
