'use strict';

// Phase 6: .env.example, the template `npm run setup` turns into .env.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - It contains exactly these active lines (in any order):
//      SEAT=0, HONEYCOMB_API_KEY=, HONEYCOMB_ENDPOINT=https://api.honeycomb.io,
//      ROASTJUDGE_EXPORTER=otlp, REPLAY_URL=http://localhost:4200/v1, PUB_GUIDE_URL=http://localhost:4100,
//      ROASTJUDGE_MODEL=replay, LOAD_INTERVAL_MS=4000, REPLAY_FAIL_EVERY=25
//    plus the commented-out optional keys `# OPENAI_API_KEY=`, `# HONEYCOMB_TEAM_SLUG=`,
//    `# HONEYCOMB_ENV_SLUG=`, `# OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`.
//  - Every active KEY=value line is immediately preceded by a `#` comment line explaining it.
//  - No real secrets: HONEYCOMB_API_KEY is empty.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '.env.example');

const ACTIVE = [
  'SEAT=0',
  'HONEYCOMB_API_KEY=',
  'HONEYCOMB_ENDPOINT=https://api.honeycomb.io',
  'ROASTJUDGE_EXPORTER=otlp',
  'REPLAY_URL=http://localhost:4200/v1',
  'PUB_GUIDE_URL=http://localhost:4100',
  'ROASTJUDGE_MODEL=replay',
  'LOAD_INTERVAL_MS=4000',
  'REPLAY_FAIL_EVERY=25',
];
const COMMENTED = ['OPENAI_API_KEY=', 'HONEYCOMB_TEAM_SLUG=', 'HONEYCOMB_ENV_SLUG=', 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false'];

function lines() {
  return fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
}

test('.env.example has every active key with its default', () => {
  const active = lines()
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const want of ACTIVE) assert.ok(active.includes(want), `missing active line ${want}\n${active.join('\n')}`);
  const keys = active.map((l) => l.split('=')[0]);
  assert.equal(new Set(keys).size, keys.length, `no duplicate keys: ${keys.join(', ')}`);
  for (const k of keys) assert.match(k, /^[A-Z][A-Z0-9_]*$/, `KEY=value form: ${k}`);
  assert.deepEqual(keys.sort(), ACTIVE.map((l) => l.split('=')[0]).sort(), 'only the listed active keys');
});

test('.env.example has the optional keys commented out', () => {
  const all = lines().map((l) => l.trim());
  for (const want of COMMENTED) {
    assert.ok(
      all.some((l) => new RegExp(`^#\\s*${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(l)),
      `missing commented line "# ${want}"`,
    );
  }
  for (const k of COMMENTED.map((l) => l.split('=')[0])) {
    assert.ok(!all.some((l) => l.startsWith(`${k}=`)), `${k} must stay commented out`);
  }
});

test('.env.example: every active KEY= line has a comment line directly above it', () => {
  const ls = lines();
  ls.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const prev = i > 0 ? ls[i - 1].trim() : '';
    assert.ok(prev.startsWith('#'), `line ${i + 1} "${t}" needs a # comment line directly above it`);
  });
});
