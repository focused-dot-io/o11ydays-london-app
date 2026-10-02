'use strict';

// compare_to_benchmarks: compares a verdict with past verdicts in a node:sqlite database.
// Ships with a hand-written CLIENT span at every checkpoint (it is infra, not an exercise).

const { DatabaseSync } = require('node:sqlite');
const { trace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { pubs, labelFor } = require('../../services/model-replay/vocabulary.js');

const name = 'compare_to_benchmarks';
const type = 'datastore';

const PUB_QUERY = 'SELECT AVG(score) AS avg, COUNT(*) AS n FROM verdicts WHERE pub = ?';
const OVERALL_QUERY = 'SELECT AVG(score) AS avg FROM verdicts';

const definition = {
  type: 'function',
  name,
  description: "Compare this roast's component scores with past verdicts for the same pub and across all pubs.",
  parameters: {
    type: 'object',
    properties: {
      scores: {
        type: 'object',
        description: 'Component scores for this roast, keyed by component id.',
        additionalProperties: { type: 'number' },
      },
      pub: { type: 'string', description: 'The pub slug.' },
    },
    required: ['scores', 'pub'],
  },
  strict: false,
};

const ROWS_PER_PUB = 5;

function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS verdicts (
    id INTEGER PRIMARY KEY,
    pub TEXT,
    score REAL,
    label TEXT,
    judged_at TEXT
  )`);
  if (db.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n === 0) {
    // Deterministic LCG so every seat gets the same history.
    let seed = 20261006;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const insert = db.prepare('INSERT INTO verdicts (pub, score, label, judged_at) VALUES (?, ?, ?, ?)');
    const start = Date.UTC(2026, 0, 4); // a Sunday
    let week = 0;
    db.exec('BEGIN');
    for (const p of pubs) {
      for (let i = 0; i < ROWS_PER_PUB; i++) {
        const score = Math.round(rand() * 100) / 10; // 0.0-10.0, tracks nothing in particular
        const judgedAt = new Date(start + week * 7 * 86400000 + 13 * 3600000).toISOString();
        insert.run(p.slug, score, labelFor(score), judgedAt);
        week = (week + 3) % 38;
      }
    }
    db.exec('COMMIT');
  }
  return db;
}

let defaultDb;
function getDefaultDb() {
  if (!defaultDb) defaultDb = openDatabase();
  return defaultDb;
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

async function execute(args = {}, ctx = {}) {
  const db = ctx.db || getDefaultDb();
  const pub = String(args.pub || '');
  const tracer = trace.getTracer('roast-judge-benchmarks');
  return tracer.startActiveSpan(
    'SELECT verdicts',
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system.name': 'sqlite',
        'db.operation.name': 'SELECT',
        'db.collection.name': 'verdicts',
        'db.query.text': `${PUB_QUERY}; ${OVERALL_QUERY}`,
      },
    },
    (span) => {
      try {
        const pubRow = db.prepare(PUB_QUERY).get(pub);
        const allRow = db.prepare(OVERALL_QUERY).get();
        const n = Number(pubRow.n);
        return {
          pub_average: n > 0 ? round1(pubRow.avg) : null,
          overall_average: round1(allRow.avg ?? 0),
          sample_size: n,
        };
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.setAttribute('error.type', (err && err.code) || (err && err.constructor && err.constructor.name) || 'Error');
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

module.exports = { name, type, definition, execute, openDatabase, PUB_QUERY, OVERALL_QUERY };
