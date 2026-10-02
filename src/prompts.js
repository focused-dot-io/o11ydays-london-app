'use strict';

// The runtime prompt switch (Module 3's flip and rollback): `npm run prompt v1|v2` or
// POST /admin/prompt changes the version for the next request, no restart.
// Each prompt file's first line is a marker the replay model reads, e.g. `<!-- roast-judge prompt v1 -->`.

const fs = require('node:fs');
const path = require('node:path');

const VERSIONS = ['v1', 'v2'];
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

let current = 'v1';
const cache = new Map();

function assertVersion(v) {
  if (!VERSIONS.includes(v)) {
    throw new Error(`unknown prompt version ${JSON.stringify(v)}: expected one of ${VERSIONS.join(', ')}`);
  }
}

function getVersion() {
  return current;
}

function setVersion(v) {
  assertVersion(v);
  current = v;
}

/** The prompt file text, verbatim (the replay model needs the marker line). */
function getPrompt(version = getVersion()) {
  assertVersion(version);
  if (!cache.has(version)) {
    cache.set(version, fs.readFileSync(path.join(PROMPTS_DIR, `roast-judge.${version}.md`), 'utf8'));
  }
  return cache.get(version);
}

module.exports = { getVersion, setVersion, getPrompt, VERSIONS };
