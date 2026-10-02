'use strict';

// model-replay: an OpenAI-compatible POST /v1/responses backed by the deterministic
// engine. Deliberately has no OpenTelemetry so it never shows up in attendees' traces.

const express = require('express');
const engine = require('./engine.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createApp({ env = process.env } = {}) {
  const callCounter = { n: 0 };
  const app = express();

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/v1/responses', express.json({ limit: '5mb' }), async (req, res) => {
    const result = engine.respond(req.body || {}, req.headers, { env, callCounter });
    if (result.latencyMs > 0) await sleep(result.latencyMs);
    res.status(result.status).json(result.body);
  });

  // Malformed JSON (or any other error) -> OpenAI-shaped JSON error.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const type = status >= 400 && status < 500 ? 'invalid_request_error' : 'server_error';
    res.status(status).json({ error: { message: err.message || 'error', type, param: null, code: null } });
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 4200;
  createApp().listen(port, () => {
    console.log(`model-replay listening on :${port}`);
  });
}
