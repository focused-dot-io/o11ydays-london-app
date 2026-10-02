'use strict';

// pub-guide: a tiny fictional pub directory. GET /pubs/:slug answers from pubs.json.
// Unknown slugs get a 200 with found:false (price band defaults to "mid"); the reserved
// slug `the-condemned-arms` always returns a 500 so `?fail=tool` has something to break.
// OTel for this process lives in ./telemetry.js, loaded with --require.

const express = require('express');
const pubs = require('./pubs.json');

const FAILING_SLUG = 'the-condemned-arms';

function createApp() {
  const bySlug = new Map(pubs.map((p) => [p.slug, p]));
  const app = express();

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/pubs/:slug', (req, res) => {
    const { slug } = req.params;
    if (slug === FAILING_SLUG) {
      res.status(500).json({ error: `pub-guide: ${slug} has been condemned by the health inspector` });
      return;
    }
    const pub = bySlug.get(slug);
    if (!pub) {
      res.json({ found: false, slug, price_band: 'mid' });
      return;
    }
    res.json({ found: true, ...pub });
  });

  return app;
}

module.exports = { createApp, FAILING_SLUG };

if (require.main === module) {
  const port = Number(process.env.PORT) || 4100;
  createApp().listen(port, () => {
    console.log(`pub-guide listening on :${port}`);
  });
}
