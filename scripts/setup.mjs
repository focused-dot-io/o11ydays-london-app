// npm run setup -- --seat N --key K: write your .env from .env.example.
//
// Copies .env.example with SEAT=N and HONEYCOMB_API_KEY=K filled in. If .env already exists, any
// extra keys you added to it (e.g. OPENAI_API_KEY) are kept; everything else comes from the example.
// If the dev processes are running (npm run dev, whose pid is in .dev.pid) they are sent SIGHUP so
// they restart and pick up the new .env. The key is never printed.
//
// Flags: --seat N        your seat number, an integer 0-999 (required)
//        --key K         your Honeycomb ingest key (required)
//        --out PATH      file to write (default <repo>/.env)
//        --example PATH  template to copy (default <repo>/.env.example)
//        --pidfile PATH  dev supervisor pidfile (default <repo>/.dev.pid)
// (The flag is --out, not --env-file: node itself grabs --env-file from the command line.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: npm run setup -- --seat N --key K   (N: your seat number 0-999, K: your Honeycomb ingest key)';
const FLAGS = ['seat', 'key', 'out', 'example', 'pidfile'];

function fail(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    // Never echo a bare value back: it may be the key.
    if (!m || !FLAGS.includes(m[1])) fail(argv[i].startsWith('--') ? `Unknown flag: ${argv[i].split('=')[0]}` : 'Unexpected value without a flag.');
    if (m[2] !== undefined) {
      opts[m[1]] = m[2];
    } else {
      if (i + 1 >= argv.length) fail(`--${m[1]} needs a value`);
      opts[m[1]] = argv[++i];
    }
  }
  return opts;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const keyOf = (line) => (line.match(KEY_LINE) || [])[1];

const opts = parseArgs(process.argv.slice(2));

if (opts.seat === undefined) fail('Missing --seat.');
if (!/^\d+$/.test(opts.seat) || Number(opts.seat) > 999) fail('Seat must be a whole number from 0 to 999.');
if (opts.key === undefined || opts.key.trim() === '') fail('Missing --key (your Honeycomb ingest key).');
if (/\s/.test(opts.key)) fail('The key must not contain spaces or line breaks; check what you pasted.');

const seat = Number(opts.seat);
const key = opts.key;
const out = opts.out ? path.resolve(opts.out) : path.join(ROOT, '.env');
const example = opts.example ? path.resolve(opts.example) : path.join(ROOT, '.env.example');
const pidfile = opts.pidfile ? path.resolve(opts.pidfile) : path.join(ROOT, '.dev.pid');

let exampleText;
try {
  exampleText = fs.readFileSync(example, 'utf8');
} catch (err) {
  fail(`Cannot read the template ${example} (${err.code || err.message}).`);
}

const lines = exampleText.replace(/\r?\n$/, '').split(/\r?\n/);
const exampleKeys = new Set(lines.map(keyOf).filter(Boolean));
const result = lines.map((line) => {
  if (keyOf(line) === 'SEAT') return `SEAT=${seat}`;
  if (keyOf(line) === 'HONEYCOMB_API_KEY') return `HONEYCOMB_API_KEY=${key}`;
  return line;
});

// Keep keys the user added to an existing .env that the example does not set.
if (fs.existsSync(out)) {
  const seen = new Set();
  const extras = [];
  for (const line of fs.readFileSync(out, 'utf8').split(/\r?\n/)) {
    const k = keyOf(line);
    if (!k || exampleKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    extras.push(line);
  }
  if (extras.length) result.push('', '# Kept from your previous .env', ...extras);
}

fs.writeFileSync(out, `${result.join('\n')}\n`, { mode: 0o600 });
console.log(`Wrote ${out} for seat ${seat}`);

// Restart the dev processes if they are running, so they pick up the new .env.
if (fs.existsSync(pidfile)) {
  const raw = fs.readFileSync(pidfile, 'utf8').trim();
  const pid = /^\d+$/.test(raw) ? Number(raw) : 0;
  let restarted = false;
  if (pid > 1) {
    try {
      process.kill(pid, 'SIGHUP');
      restarted = true;
    } catch {
      // not running (or not ours): treated as stale below
    }
  }
  if (restarted) console.log('Restarting dev processes');
  else console.log(`Note: ${pidfile} is stale (no running dev process), ignoring it. Start the app with: npm run dev`);
}
