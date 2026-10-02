'use strict';

// Test helper (no `.test.js` suffix): a tiny stand-in for the Roast Judge HTTP API, used to observe
// exactly what scripts/load.mjs sends (paths, headers, bodies, order) without running the real app.
// Routes: POST /judge, POST /judge/:id/appeal, POST /judge/:id/final -> canned 200 JSON in the app's
// response shape; anything else 404. Every request is recorded in `requests` as
// { method, path, headers, body }.

const http = require('node:http');

let counter = 0;

function hex32(n) {
  return n.toString(16).padStart(32, '0');
}

function createFakeJudge() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      let body = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // keep raw
      }
      const path = req.url.split('?')[0];
      requests.push({ method: req.method, path, headers: req.headers, body });
      counter += 1;
      const traceId = hex32(0xabc0000 + counter);
      let m;
      let payload;
      if (req.method === 'POST' && path === '/judge') {
        const id = `fakeconv${String(counter).padStart(8, '0')}`;
        payload = { conversation_id: id, trace_id: traceId, verdict: { score: 7, label: 'solid', reason: 'fine' }, components_scored: 3, prompt_version: 'v1' };
      } else if (req.method === 'POST' && (m = path.match(/^\/judge\/([^/]+)\/appeal$/))) {
        payload = { conversation_id: decodeURIComponent(m[1]), trace_id: traceId, verdict: { score: 8, label: 'solid', reason: 'ok' }, components_scored: 1, prompt_version: 'v1' };
      } else if (req.method === 'POST' && (m = path.match(/^\/judge\/([^/]+)\/final$/))) {
        payload = { conversation_id: decodeURIComponent(m[1]), trace_id: traceId, verdict: { score: 8, label: 'solid', reason: 'ok', ruling: 'overturned' }, components_scored: 0, prompt_version: 'v1' };
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-trace-id': traceId });
      res.end(JSON.stringify(payload));
    });
  });
  const fake = {
    requests,
    url: null,
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          fake.url = `http://127.0.0.1:${server.address().port}`;
          resolve(fake);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  return fake;
}

module.exports = { createFakeJudge };
