// npm run prompt [v1|v2]: show or switch the judge's system prompt in the running app, no restart.
//   npm run prompt        prints the current version (GET /admin/prompt)
//   npm run prompt v2     switches to v2 (POST /admin/prompt {"version":"v2"}) and prints it
// Module 3 uses this to flip the prompt at runtime and roll it back.
// Env: ROASTJUDGE_URL (default http://localhost:3000).

const VERSIONS = ['v1', 'v2'];
const base = (process.env.ROASTJUDGE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const wanted = process.argv[2];

if (process.argv.length > 3 || (wanted !== undefined && !VERSIONS.includes(wanted))) {
  console.error(`usage: npm run prompt [${VERSIONS.join('|')}]   (no argument prints the current version)`);
  process.exit(1);
}

let res;
try {
  res = await fetch(
    `${base}/admin/prompt`,
    wanted
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: wanted }) }
      : { method: 'GET' },
  );
} catch (err) {
  console.error(`Could not reach Roast Judge at ${base} (${err.cause?.code || err.message}).`);
  console.error('Is the app running? npm run dev');
  process.exit(1);
}

const raw = await res.text();
let body = {};
try {
  body = JSON.parse(raw);
} catch {
  // reported below
}
if (!res.ok || !body.version) {
  console.error(`Roast Judge answered ${res.status}: ${body.message || body.error || raw}`.trim());
  process.exit(1);
}
console.log(`prompt version: ${body.version}`);
