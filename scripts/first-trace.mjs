// npm run first-trace: send one roast to the running app and print where its trace lives.
// Env: ROASTJUDGE_URL (default http://localhost:3000), SEAT (default 0),
//      HONEYCOMB_TEAM_SLUG + HONEYCOMB_ENV_SLUG (optional: print a direct UI link).

import fs from 'node:fs';

const corpus = JSON.parse(fs.readFileSync(new URL('../replay/corpus.json', import.meta.url), 'utf8'));
const base = (process.env.ROASTJUDGE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const seat = process.env.SEAT || '0';
const dataset = `roast-judge-${seat}`;
const roast = corpus[0];

let res;
try {
  res = await fetch(`${base}/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roastjudge-model': 'replay' },
    body: JSON.stringify({ text: roast.text }),
  });
} catch (err) {
  console.error(`Could not reach Roast Judge at ${base} (${err.cause?.code || err.message}).`);
  console.error('Is the app running? npm run dev');
  process.exit(1);
}

const raw = await res.text();
let body;
try {
  body = JSON.parse(raw);
} catch {
  body = { message: raw };
}
if (!res.ok) {
  console.error(`Roast Judge answered ${res.status}: ${body.error || ''} ${body.message || ''}`.trim());
  if (body.trace_id) console.error(`Trace ID: ${body.trace_id} (the failed request is traced too)`);
  process.exit(1);
}

const { verdict } = body;
console.log(`Roast:    ${roast.text}`);
console.log(`Verdict:  ${verdict.score}/10, ${verdict.label}. ${verdict.reason}`);
console.log('');
console.log(`Trace ID: ${body.trace_id}`);
console.log(`Dataset:  ${dataset}`);

const team = process.env.HONEYCOMB_TEAM_SLUG;
const env = process.env.HONEYCOMB_ENV_SLUG;
if (team && env) {
  console.log(`Open:     https://ui.honeycomb.io/${team}/environments/${env}/datasets/${dataset}/trace?trace_id=${body.trace_id}`);
} else {
  console.log(`Find it:  in Honeycomb open dataset ${dataset}, query WHERE trace.trace_id = ${body.trace_id}, click the trace.`);
}
