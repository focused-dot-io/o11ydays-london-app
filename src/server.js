'use strict';

// Roast Judge's HTTP API.
//   POST /judge                 { text }  -> turn 1: the verdict
//   POST /judge/:id/appeal      { text }  -> turn 2: the punter disputes it
//   POST /judge/:id/final       {}        -> turn 3: the final ruling (upheld / overturned)
//   GET|POST /admin/prompt      { version: 'v1'|'v2' } -> the runtime prompt switch
//   GET /healthz
// Every response carries `x-trace-id`; judge responses also put it in the body as `trace_id`.
// `?fail=model` makes the replay model return a 500; `?fail=tool` makes lookup_pub fail.

const express = require('express');
const { OpenAI } = require('openai');
const { trace } = require('@opentelemetry/api');
const defaultConversations = require('./conversations.js');
const prompts = require('./prompts.js');
const { getClient } = require('./model-client.js');
const { runAgent, VerdictParseError } = require('./agent.js');

const FINAL_TEXT = 'Give your final ruling.';

const currentTraceId = () => trace.getActiveSpan()?.spanContext().traceId;

function pubGuideUrl() {
  return (process.env.PUB_GUIDE_URL || 'http://localhost:4100').replace(/\/+$/, '');
}

function textOf(body) {
  const text = body && body.text;
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

function errorResponse(err) {
  if (err instanceof VerdictParseError) return { status: 502, error: 'verdict_parse_error' };
  if (err instanceof OpenAI.APIError || (err && typeof err.status === 'number')) {
    return { status: 502, error: 'model_error' };
  }
  return { status: 500, error: 'internal_error' };
}

function createApp({ conversations = defaultConversations } = {}) {
  const app = express();

  // The http instrumentation's SERVER span is active here, so every response gets its trace id.
  app.use(function traceIdHeader(req, res, next) {
    const traceId = currentTraceId();
    if (traceId) res.setHeader('x-trace-id', traceId);
    next();
  });
  app.use(express.json());

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/admin/prompt', (req, res) => {
    res.json({ version: prompts.getVersion() });
  });

  app.post('/admin/prompt', (req, res) => {
    try {
      prompts.setVersion(req.body && req.body.version);
    } catch (err) {
      res.status(400).json({ error: 'bad_version', message: err.message });
      return;
    }
    res.json({ version: prompts.getVersion() });
  });

  async function judgeTurn(req, res, conversation, turn, text) {
    const traceId = currentTraceId();
    const promptVersion = prompts.getVersion();
    try {
      const result = await runAgent({
        conversation,
        turn,
        text,
        client: getClient(req),
        promptVersion,
        pubGuideUrl: pubGuideUrl(),
        failTool: req.query.fail === 'tool',
        failModel: req.query.fail === 'model',
      });
      const verdict = { score: result.score, label: result.label, reason: result.reason };
      if (result.ruling !== undefined) verdict.ruling = result.ruling;
      res.json({
        conversation_id: conversation.id,
        trace_id: traceId,
        verdict,
        components_scored: result.components_scored,
        prompt_version: promptVersion,
      });
    } catch (err) {
      const { status, error } = errorResponse(err);
      if (status === 500) console.error(err);
      res.status(status).json({ error, message: err.message, trace_id: traceId });
    }
  }

  app.post('/judge', async (req, res) => {
    const text = textOf(req.body);
    if (!text) {
      res.status(400).json({ error: 'text_required', message: 'POST a JSON body like {"text": "..."}' });
      return;
    }
    await judgeTurn(req, res, conversations.create(), 1, text);
  });

  app.post('/judge/:id/appeal', async (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'conversation_not_found' });
      return;
    }
    const text = textOf(req.body);
    if (!text) {
      res.status(400).json({ error: 'text_required', message: 'POST a JSON body like {"text": "..."}' });
      return;
    }
    await judgeTurn(req, res, conversation, 2, text);
  });

  app.post('/judge/:id/final', async (req, res) => {
    const conversation = conversations.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'conversation_not_found' });
      return;
    }
    await judgeTurn(req, res, conversation, 3, FINAL_TEXT);
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`roast-judge listening on http://localhost:${port} (prompt ${prompts.getVersion()})`);
  });
}
