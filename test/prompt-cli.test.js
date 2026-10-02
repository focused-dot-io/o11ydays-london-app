'use strict';

// Phase 6: scripts/prompt.mjs (`npm run prompt v1|v2`), the CLI for the runtime prompt switch.
// SPEC: calls the admin endpoint.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - Target is ROASTJUDGE_URL (default http://localhost:3000); never loads .env or telemetry.
//  - `prompt.mjs v2` -> POST /admin/prompt {version:"v2"}, prints `prompt version: v2`, exit 0.
//  - `prompt.mjs` (no arg) -> GET /admin/prompt, prints `prompt version: <v>`, exit 0.
//  - Invalid arg (e.g. v9) -> exit 1 with a usage message (mentions "usage", case-insensitive),
//    without calling the app.
//  - Unreachable app -> exit 1 with `Is the app running? npm run dev`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, freePort } = require('./helpers/app-harness.js');
const { runNode } = require('./helpers/run-script.js');

let h;

before(async () => {
  h = await createHarness();
}, { timeout: 20000 });

after(async () => {
  if (h) {
    try {
      await h.setPrompt('v1');
    } finally {
      await h.stop();
    }
  }
});

const prompt = (args, env) => runNode(['scripts/prompt.mjs', ...args], { env: { ROASTJUDGE_URL: h.appUrl, ...env } });

test('prompt (no arg) prints the current version', async () => {
  const res = await prompt([]);
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /prompt version: v1\b/, res.info);
});

test('prompt v2 switches the running app and prints the new version; v1 switches back', async () => {
  const res = await prompt(['v2']);
  assert.equal(res.status, 0, res.info);
  assert.match(res.stdout, /prompt version: v2\b/, res.info);
  assert.equal((await h.getPrompt()).body.version, 'v2');

  const get = await prompt([]);
  assert.match(get.stdout, /prompt version: v2\b/, get.info);

  const back = await prompt(['v1']);
  assert.equal(back.status, 0, back.info);
  assert.match(back.stdout, /prompt version: v1\b/, back.info);
  assert.equal((await h.getPrompt()).body.version, 'v1');
});

test('prompt v9 -> exit 1 with usage, app unchanged', async () => {
  const res = await prompt(['v9']);
  assert.equal(res.status, 1, res.info);
  assert.match(res.out, /usage/i, res.info);
  assert.equal((await h.getPrompt()).body.version, 'v1');
});

test('prompt against an unreachable app -> exit 1 with a hint', async () => {
  const port = await freePort();
  const res = await prompt(['v2'], { ROASTJUDGE_URL: `http://127.0.0.1:${port}` });
  assert.equal(res.status, 1, res.info);
  assert.ok(res.out.includes('Is the app running? npm run dev'), res.info);
});
