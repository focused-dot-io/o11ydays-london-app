'use strict';

// TEST-ONLY entry point for the Roast Judge app, run by test/helpers/app-harness.js as:
//   node --require ./src/telemetry.js --disable-warning=ExperimentalWarning test/helpers/app-child.js
// with ROASTJUDGE_EXPORTER=memory. It serves the real app from src/server.js (createApp()) and adds
// two test-only routes IN FRONT of it (they live here, never in src/):
//   GET  /__spans        force-flush, then return the in-memory exporter's finished spans as JSON
//   POST /__spans/reset  clear the in-memory exporter
// The app is wrapped in a plain http server so the app's own routing (and the http.route the express
// instrumentation records) is untouched.

const http = require('node:http');
const { trace } = require('@opentelemetry/api');
const telemetry = require('../../src/telemetry.js');
const { createApp } = require('../../src/server.js');

const app = createApp();

function serialise(s) {
  const ctx = s.spanContext();
  const parent = s.parentSpanContext ? s.parentSpanContext.spanId : s.parentSpanId;
  return {
    name: s.name,
    kind: s.kind,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: parent || undefined,
    scope: s.instrumentationScope ? s.instrumentationScope.name : undefined,
    status: { code: s.status.code, message: s.status.message },
    attributes: s.attributes,
    events: (s.events || []).map((e) => ({ name: e.name, attributes: e.attributes })),
  };
}

async function flush() {
  const tp = trace.getTracerProvider();
  const real = typeof tp.getDelegate === 'function' ? tp.getDelegate() : tp;
  if (real && typeof real.forceFlush === 'function') await real.forceFlush();
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__spans' || url === '/__spans/reset') {
    try {
      if (!telemetry.memoryExporter) throw new Error('memoryExporter is null: set ROASTJUDGE_EXPORTER=memory');
      await flush();
      let payload;
      if (url === '/__spans/reset' && req.method === 'POST') {
        telemetry.memoryExporter.reset();
        payload = { ok: true };
      } else {
        payload = telemetry.memoryExporter.getFinishedSpans().map(serialise);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String((err && err.stack) || err) }));
    }
    return;
  }
  app(req, res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '127.0.0.1', () => {
  console.log(`app-child listening on :${port}`);
});
