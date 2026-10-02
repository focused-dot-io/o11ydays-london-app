'use strict';

// Pure span/log processors used by src/telemetry.js. No side effects on require.

const { context, trace } = require('@opentelemetry/api');

// Attributes a gen_ai child span copies from its parent at start, so every chat and
// execute_tool span can be grouped by prompt version, conversation and agent.
const INHERITED_KEYS = [
  'gen_ai.prompt.name',
  'gen_ai.prompt.version',
  'gen_ai.conversation.id',
  'gen_ai.agent.name',
];

const DEFAULT_REPLAY_URL = 'http://localhost:4200/v1';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normHost(host) {
  const h = String(host || '').toLowerCase();
  return LOOPBACK.has(h) ? 'localhost' : h;
}

// True when (address, port) is the host:port the replay URL points at.
function isReplayAddress(address, port, replayUrl) {
  if (!address || !replayUrl) return false;
  let url;
  try {
    url = new URL(replayUrl);
  } catch {
    return false;
  }
  if (normHost(address) !== normHost(url.hostname)) return false;
  if (port === undefined || port === null || port === '') return true;
  const replayPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return Number(port) === replayPort;
}

class InheritAttributesSpanProcessor {
  constructor({ replayUrl } = {}) {
    this._replayUrl = replayUrl;
  }

  onStart(span, parentContext) {
    const attrs = span.attributes || {};
    if (attrs['gen_ai.operation.name'] === undefined) return;

    const parent = parentContext ? trace.getSpan(parentContext) : undefined;
    const parentAttrs = parent && parent.attributes;
    if (parentAttrs) {
      for (const key of INHERITED_KEYS) {
        if (attrs[key] === undefined && parentAttrs[key] !== undefined) {
          span.setAttribute(key, parentAttrs[key]);
        }
      }
    }

    const address = attrs['server.address'];
    if (address) {
      const replayUrl = this._replayUrl || process.env.REPLAY_URL || DEFAULT_REPLAY_URL;
      span.setAttribute('roastjudge.model.replay', isReplayAddress(address, attrs['server.port'], replayUrl));
    }
  }

  onEnd() {}

  forceFlush() {
    return Promise.resolve();
  }

  shutdown() {
    return Promise.resolve();
  }
}

// instrumentation-openai emits message content as log records; copy it onto the chat span
// (still open when the record is emitted) as JSON strings. Only register when capture is on.
const CONTENT_KEYS = ['gen_ai.input.messages', 'gen_ai.output.messages'];

class ContentToSpanLogProcessor {
  onEmit(record, ctx) {
    const span = trace.getSpan(ctx ?? context.active());
    if (!span) return;
    const attrs = (record && record.attributes) || {};
    for (const key of CONTENT_KEYS) {
      const value = attrs[key];
      if (value === undefined) continue;
      try {
        span.setAttribute(key, typeof value === 'string' ? value : JSON.stringify(value));
      } catch {
        // never break the caller over telemetry
      }
    }
  }

  forceFlush() {
    return Promise.resolve();
  }

  shutdown() {
    return Promise.resolve();
  }
}

module.exports = { InheritAttributesSpanProcessor, ContentToSpanLogProcessor, INHERITED_KEYS, isReplayAddress };
