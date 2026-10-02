'use strict';

// Picks the OpenAI client for a request. Replay is the default; live needs
// ROASTJUDGE_MODEL=live AND OPENAI_API_KEY, and the header `x-roastjudge-model: replay`
// forces replay per request (the load generator always sends it). Env is read at call time.

const { OpenAI } = require('openai');

const REQUEST_MODEL = 'gpt-4.1-mini';

function replayUrl() {
  return process.env.REPLAY_URL || 'http://localhost:4200/v1';
}

function headerOf(req, name) {
  const headers = (req && req.headers) || {};
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function isReplayRequest(req) {
  if (process.env.ROASTJUDGE_MODEL !== 'live' || !process.env.OPENAI_API_KEY) return true;
  return String(headerOf(req, 'x-roastjudge-model') || '').toLowerCase() === 'replay';
}

function getClient(req) {
  if (isReplayRequest(req)) {
    return new OpenAI({ baseURL: replayUrl(), apiKey: 'replay', maxRetries: 0, timeout: 15000 });
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
}

module.exports = { getClient, isReplayRequest, replayUrl, REQUEST_MODEL };
