'use strict';

// Phase 6: scripts/setup.mjs (`npm run setup -- --seat N --key K`).
// SPEC: writes .env from .env.example; restarts dev processes if the dev pidfile exists.
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  - NOTE: the output flag is --out, NOT --env-file: node (22 and 25) scans argv for --env-file even
//    after the script name and tries to load that file itself (exit 9 "not found").
//  - CLI: --seat N --key K [--out PATH (default .env)] [--example PATH (default .env.example)]
//    [--pidfile PATH (default .dev.pid)]. Relative defaults resolve against the repo root.
//  - Output .env = the example's lines with `SEAT=N` and `HONEYCOMB_API_KEY=K` substituted, every other
//    example line preserved verbatim (comments included).
//  - --seat must be an integer 0..999 and --key non-empty; otherwise exit 1 and nothing is written.
//  - If the .env already exists, keys in it that are not active keys of the example (e.g.
//    OPENAI_API_KEY=sk-x) are kept (once); SEAT and HONEYCOMB_API_KEY are overwritten.
//  - Prints `Wrote <path> for seat N`; never prints the key value (stdout or stderr).
//  - If the pidfile holds a live pid: send it SIGHUP and print `Restarting dev processes`.
//    A stale pidfile (dead pid) is ignored with a note; exit 0 either way. No pidfile: no restart line.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, runNode, waitFor } = require('./helpers/run-script.js');

const EXAMPLE = path.join(ROOT, '.env.example');
const KEY = 'hcaik_test_SECRET_9f8e7d6c5b4a';

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-setup-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function paths() {
  n += 1;
  return { env: path.join(tmp, `env-${n}`), pid: path.join(tmp, `dev-${n}.pid`) };
}

function setup(args) {
  return runNode(['scripts/setup.mjs', ...args]);
}

function parseEnv(file) {
  const out = {};
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

test('setup writes .env from the example with SEAT and the key, preserving every other line', async () => {
  const p = paths();
  const res = await setup(['--seat', '7', '--key', KEY, '--out', p.env, '--example', EXAMPLE, '--pidfile', p.pid]);
  assert.equal(res.status, 0, res.info);
  assert.ok(res.stdout.includes(`Wrote ${p.env} for seat 7`), res.info);
  assert.ok(!res.out.includes(KEY), `the key value is never printed\n${res.info}`);
  assert.doesNotMatch(res.out, /Restarting dev processes/, 'no pidfile, no restart');

  const written = fs.readFileSync(p.env, 'utf8').split(/\r?\n/);
  const example = fs.readFileSync(EXAMPLE, 'utf8').split(/\r?\n/);
  assert.ok(written.includes('SEAT=7'), written.join('\n'));
  assert.ok(written.includes(`HONEYCOMB_API_KEY=${KEY}`), written.join('\n'));
  assert.ok(!written.includes('SEAT=0'));
  for (const l of example) {
    if (l.startsWith('SEAT=') || l.startsWith('HONEYCOMB_API_KEY=')) continue;
    assert.ok(written.includes(l), `example line preserved: "${l}"`);
  }
});

test('setup with an existing .env keeps extra keys and overwrites SEAT and the key', async () => {
  const p = paths();
  fs.writeFileSync(p.env, 'SEAT=3\nHONEYCOMB_API_KEY=old-key\nOPENAI_API_KEY=sk-x\nROASTJUDGE_MODEL=replay\n');
  const res = await setup(['--seat', '12', '--key', KEY, '--out', p.env, '--example', EXAMPLE, '--pidfile', p.pid]);
  assert.equal(res.status, 0, res.info);
  const text = fs.readFileSync(p.env, 'utf8');
  const env = parseEnv(p.env);
  assert.equal(env.SEAT, '12');
  assert.equal(env.HONEYCOMB_API_KEY, KEY);
  assert.equal(env.OPENAI_API_KEY, 'sk-x', text);
  assert.equal(text.match(/^OPENAI_API_KEY=/gm).length, 1, `OPENAI_API_KEY once\n${text}`);
  assert.equal(text.match(/^SEAT=/gm).length, 1, `SEAT once\n${text}`);
  assert.equal(text.match(/^HONEYCOMB_API_KEY=/gm).length, 1, `key once\n${text}`);
  assert.ok(!text.includes('old-key'));
  assert.ok(!res.out.includes(KEY), res.info);
});

for (const [label, args] of [
  ['seat not a number', ['--seat', 'abc', '--key', KEY]],
  ['seat 1000', ['--seat', '1000', '--key', KEY]],
  ['seat -1', ['--seat', '-1', '--key', KEY]],
  ['seat 1.5', ['--seat', '1.5', '--key', KEY]],
  ['seat missing', ['--key', KEY]],
  ['key empty', ['--seat', '1', '--key', '']],
  ['key missing', ['--seat', '1']],
]) {
  test(`setup refuses: ${label} -> exit 1, nothing written`, async () => {
    const p = paths();
    const res = await setup([...args, '--out', p.env, '--example', EXAMPLE, '--pidfile', p.pid]);
    assert.doesNotMatch(res.out, /ERR_MODULE_NOT_FOUND|Cannot find module/, res.info);
    assert.equal(res.status, 1, res.info);
    assert.ok(!fs.existsSync(p.env), 'no .env written');
    assert.match(res.out, /usage|seat|key/i, `explains what is wrong\n${res.info}`);
    assert.ok(!res.out.includes(KEY), res.info);
  });
}

test('setup accepts the seat bounds 0 and 999', async () => {
  for (const seat of ['0', '999']) {
    const p = paths();
    const res = await setup(['--seat', seat, '--key', KEY, '--out', p.env, '--example', EXAMPLE, '--pidfile', p.pid]);
    assert.equal(res.status, 0, res.info);
    assert.equal(parseEnv(p.env).SEAT, seat);
  }
});

test('setup with a live dev pidfile sends SIGHUP and says so', async () => {
  const p = paths();
  const dev = spawn(
    process.execPath,
    ['-e', "process.on('SIGHUP',()=>{console.log('GOT_SIGHUP');process.exit(0)});console.log('ready');setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  dev.stdout.on('data', (d) => {
    out += d;
  });
  const exited = new Promise((r) => dev.on('exit', r));
  try {
    assert.ok(await waitFor(() => out.includes('ready'), 3000), 'fake dev process ready');
    fs.writeFileSync(p.pid, `${dev.pid}\n`);
    const res = await setup(['--seat', '4', '--key', KEY, '--out', p.env, '--example', EXAMPLE, '--pidfile', p.pid]);
    assert.equal(res.status, 0, res.info);
    assert.match(res.stdout, /Restarting dev processes/, res.info);
    assert.ok(await waitFor(() => out.includes('GOT_SIGHUP'), 3000), `dev process got SIGHUP (out: ${out})`);
  } finally {
    dev.kill('SIGKILL');
    await exited;
  }
});

test('setup with a stale pidfile ignores it with a note', async () => {
  const p = paths();
  fs.writeFileSync(p.pid, '999999\n');
  const res = await setup(['--seat', '5', '--key', KEY, '--out', p.env, '--example', EXAMPLE, '--pidfile', p.pid]);
  assert.equal(res.status, 0, res.info);
  assert.doesNotMatch(res.stdout, /Restarting dev processes/, res.info);
  assert.ok(res.out.trim().split('\n').length >= 2, `a note about the stale pidfile besides the Wrote line\n${res.info}`);
  assert.equal(parseEnv(p.env).SEAT, '5');
});
