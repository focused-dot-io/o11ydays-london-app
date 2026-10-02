'use strict';

// Phase 2: src/tools/{score-component,lookup-pub,benchmarks}.js
// ASSUMPTIONS (beyond SPEC.md):
//  - ctx.pubGuideUrl is a base URL with no trailing slash (e.g. http://127.0.0.1:4100);
//    lookup_pub fetches `${pubGuideUrl}/pubs/${slug}`.
//  - The seeded `verdicts` table has (at least) columns `pub` (vocabulary slug) and
//    `score` (0-10); every vocabulary pub has at least one row.
//  - compare_to_benchmarks: pub_average = AVG(score) for that pub (may be rounded to 1
//    decimal), overall_average = AVG(score) over all rows, sample_size = row count for
//    that pub. Unknown pub -> pub_average null, sample_size 0, overall_average still a number.
//  - compare_to_benchmarks opens its own in-memory DB when ctx.db is absent.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { trace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const { components: VOCAB_COMPONENTS, pubs: VOCAB_PUBS } = require('../services/model-replay/vocabulary.js');
const FAILING_SLUG = 'the-condemned-arms';

const loadScore = () => require('../src/tools/score-component.js');
const loadLookup = () => require('../src/tools/lookup-pub.js');
const loadBench = () => require('../src/tools/benchmarks.js');

const EXPECTED = [
  { load: loadScore, file: 'score-component.js', name: 'score_component', type: 'function', required: ['component'] },
  { load: loadLookup, file: 'lookup-pub.js', name: 'lookup_pub', type: 'extension', required: ['slug'] },
  { load: loadBench, file: 'benchmarks.js', name: 'compare_to_benchmarks', type: 'datastore', required: ['scores', 'pub'] },
];

function listen(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, base: `http://127.0.0.1:${srv.address().port}` }));
    srv.on('error', reject);
  });
}

// ------------------------------------------------------------------ module shape

for (const e of EXPECTED) {
  test(`tools/${e.file}: exports { name, type, definition, execute } (${e.name} / ${e.type})`, () => {
    const mod = e.load();
    assert.equal(mod.name, e.name);
    assert.equal(mod.type, e.type);
    assert.equal(typeof mod.execute, 'function');
    const d = mod.definition;
    assert.equal(d.type, 'function');
    assert.equal(d.name, e.name);
    assert.equal(d.name, mod.name);
    assert.equal(typeof d.description, 'string');
    assert.ok(d.description.trim().length > 0, 'non-empty description');
    assert.equal(d.strict, false);
    assert.equal(d.parameters.type, 'object');
    assert.ok(d.parameters.properties && typeof d.parameters.properties === 'object');
    for (const r of e.required) {
      assert.ok(r in d.parameters.properties, `parameters.properties.${r}`);
      assert.ok(Array.isArray(d.parameters.required) && d.parameters.required.includes(r), `required includes ${r}`);
    }
    assert.ok(!('instructions' in d));
  });
}

// ------------------------------------------------------------------ score_component

test('score_component: returns { component, score } with score 0-10, one decimal', async () => {
  const { execute } = loadScore();
  const out = await execute({ component: 'yorkshire', notes: 'perfect, risen, crisp' }, {});
  assert.equal(out.component, 'yorkshire');
  assert.equal(typeof out.score, 'number');
  assert.ok(Number.isFinite(out.score));
  assert.ok(out.score >= 0 && out.score <= 10, `score ${out.score}`);
  assert.equal(Math.round(out.score * 10) / 10, out.score, `score ${out.score} has at most one decimal`);
});

test('score_component: every vocabulary component scores in range', async () => {
  const { execute } = loadScore();
  for (const c of VOCAB_COMPONENTS) {
    const out = await execute({ component: c.id, notes: `The ${c.id} was fine.` }, {});
    assert.equal(out.component, c.id);
    assert.ok(out.score >= 0 && out.score <= 10, `${c.id} score ${out.score}`);
  }
});

test('score_component: deterministic for the same arguments', async () => {
  const { execute } = loadScore();
  const args = { component: 'gravy', notes: 'glossy, rich, made from the roasting juices' };
  const a = await execute({ ...args }, {});
  const b = await execute({ ...args }, {});
  assert.deepEqual(a, b);
});

test('score_component: glowing notes score higher than damning notes', async () => {
  const { execute } = loadScore();
  for (const component of ['yorkshire', 'roasties', 'gravy', 'meat']) {
    const good = await execute({ component, notes: 'perfect, risen, crisp' }, {});
    const bad = await execute({ component, notes: 'soggy, flat, burnt, from a packet' }, {});
    assert.ok(good.score > bad.score, `${component}: good ${good.score} > bad ${bad.score}`);
  }
});

test('score_component: unknown component rejects', async () => {
  const { execute } = loadScore();
  await assert.rejects(async () => execute({ component: 'pudding', notes: 'sticky toffee' }, {}));
});

// ------------------------------------------------------------------ lookup_pub

let pubGuide; // { server, base, paths }

before(async () => {
  let createApp;
  try {
    ({ createApp } = require('../services/pub-guide/server.js'));
  } catch {
    return; // lookup tests fail on their own with a clear message
  }
  const app = createApp();
  const paths = [];
  const { server, base } = await listen((req, res) => {
    paths.push(req.url);
    app(req, res);
  });
  pubGuide = { server, base, paths };
});

after(async () => {
  if (pubGuide) {
    pubGuide.server.closeAllConnections();
    await new Promise((r) => pubGuide.server.close(() => r()));
  }
});

beforeEach(() => {
  if (pubGuide) pubGuide.paths.length = 0;
});

test('lookup_pub: known slug returns the pub-guide body (found: true)', async () => {
  assert.ok(pubGuide, 'pub-guide app available');
  const { execute } = loadLookup();
  const slug = 'the-gravy-boat';
  const out = await execute({ slug }, { pubGuideUrl: pubGuide.base });
  const direct = await (await fetch(`${pubGuide.base}/pubs/${slug}`)).json();
  assert.equal(out.found, true);
  assert.equal(out.slug, slug);
  assert.equal(out.price_band, VOCAB_PUBS.find((p) => p.slug === slug).price_band);
  assert.deepEqual(out, direct);
  assert.ok(pubGuide.paths.includes(`/pubs/${slug}`), `requested /pubs/${slug}: ${pubGuide.paths}`);
});

test('lookup_pub: unknown slug resolves found: false, price_band mid', async () => {
  assert.ok(pubGuide, 'pub-guide app available');
  const { execute } = loadLookup();
  const out = await execute({ slug: 'no-such-pub' }, { pubGuideUrl: pubGuide.base });
  assert.equal(out.found, false);
  assert.equal(out.price_band, 'mid');
});

test('lookup_pub: ctx.failTool requests the-condemned-arms and rejects with an Error', async () => {
  assert.ok(pubGuide, 'pub-guide app available');
  const { execute } = loadLookup();
  await assert.rejects(
    execute({ slug: 'the-gravy-boat' }, { pubGuideUrl: pubGuide.base, failTool: true }),
    (err) => {
      assert.ok(err instanceof Error, 'rejects with an Error');
      assert.match(err.message, /500|the-condemned-arms/);
      return true;
    },
  );
  assert.ok(pubGuide.paths.includes(`/pubs/${FAILING_SLUG}`), `requested the reserved slug: ${pubGuide.paths}`);
  assert.ok(!pubGuide.paths.includes('/pubs/the-gravy-boat'), 'did not request the real slug');
});

// ------------------------------------------------------------------ compare_to_benchmarks

test('benchmarks: openDatabase() returns a seeded node:sqlite DatabaseSync', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDatabase } = loadBench();
  assert.equal(typeof openDatabase, 'function');
  const db = openDatabase();
  assert.ok(db instanceof DatabaseSync);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM verdicts').get();
  assert.ok(n >= 30, `${n} seeded rows`);
  const slugs = new Set(VOCAB_PUBS.map((p) => p.slug));
  const rows = db.prepare('SELECT pub, score FROM verdicts').all();
  for (const r of rows) {
    assert.ok(slugs.has(r.pub), `row pub ${r.pub} is a vocabulary slug`);
    assert.equal(typeof r.score, 'number');
    assert.ok(r.score >= 0 && r.score <= 10, `row score ${r.score}`);
  }
  for (const s of slugs) assert.ok(rows.some((r) => r.pub === s), `seed has a row for ${s}`);
  assert.ok(!rows.some((r) => r.pub === FAILING_SLUG));
  db.close();
});

test("benchmarks: openDatabase(':memory:') also works", () => {
  const { openDatabase } = loadBench();
  const db = openDatabase(':memory:');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n >= 30);
  db.close();
});

test('benchmarks: execute returns { pub_average, overall_average, sample_size } for a known pub', async () => {
  const { execute, openDatabase } = loadBench();
  const db = openDatabase();
  const out = await execute({ scores: { meat: 8, roasties: 6 }, pub: 'the-gravy-boat' }, { db });
  assert.equal(typeof out.pub_average, 'number');
  assert.equal(typeof out.overall_average, 'number');
  assert.ok(Number.isInteger(out.sample_size) && out.sample_size > 0, `sample_size ${out.sample_size}`);

  const pubAgg = db.prepare('SELECT AVG(score) AS avg, COUNT(*) AS n FROM verdicts WHERE pub = ?').get('the-gravy-boat');
  const all = db.prepare('SELECT AVG(score) AS avg FROM verdicts').get();
  assert.equal(out.sample_size, pubAgg.n);
  assert.ok(Math.abs(out.pub_average - pubAgg.avg) <= 0.05, `pub_average ${out.pub_average} ~ ${pubAgg.avg}`);
  assert.ok(Math.abs(out.overall_average - all.avg) <= 0.05, `overall_average ${out.overall_average} ~ ${all.avg}`);
  db.close();
});

test('benchmarks: unknown pub -> pub_average null, sample_size 0', async () => {
  const { execute, openDatabase } = loadBench();
  const db = openDatabase();
  const out = await execute({ scores: { meat: 5 }, pub: 'unknown-pub' }, { db });
  assert.equal(out.pub_average, null);
  assert.equal(out.sample_size, 0);
  assert.equal(typeof out.overall_average, 'number');
  db.close();
});

test('benchmarks: works without ctx.db', async () => {
  const { execute } = loadBench();
  const out = await execute({ scores: {}, pub: 'the-crispy-spud' }, {});
  assert.equal(typeof out.overall_average, 'number');
  assert.ok(out.sample_size > 0);
});

test('benchmarks: execute emits exactly one CLIENT span "SELECT verdicts" with db.* attributes', async () => {
  const { execute, openDatabase } = loadBench();
  const db = openDatabase();
  exporter.reset();
  await execute({ scores: { meat: 8, roasties: 6 }, pub: 'the-gravy-boat' }, { db });
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1, `finished spans: ${spans.map((s) => s.name)}`);
  const [span] = spans;
  assert.equal(span.name, 'SELECT verdicts');
  assert.equal(span.kind, SpanKind.CLIENT);
  assert.equal(span.attributes['db.system.name'], 'sqlite');
  assert.equal(span.attributes['db.operation.name'], 'SELECT');
  assert.equal(span.attributes['db.collection.name'], 'verdicts');
  assert.equal(typeof span.attributes['db.query.text'], 'string');
  assert.match(span.attributes['db.query.text'], /verdicts/);
  assert.notEqual(span.status.code, SpanStatusCode.ERROR);
  db.close();
});
