// Antigravity CLI (agy) telemetry hook for the Roast Judge workshop (Act 1).
//
// agy has no OpenTelemetry exporter of its own (google-antigravity/antigravity-cli#366), but it runs
// hooks from the workspace's .agents/hooks.json (template: telemetry/agy-hooks.json). This script is
// that hook: agy pipes one JSON payload per event to stdin, and the script sends one span per event
// to Honeycomb as OTLP/JSON. Every span of a conversation shares a trace ID, so a session is one trace.
//
//   node telemetry/agy-hook.mjs <PostToolUse|PostInvocation|Stop>   (payload on stdin)
//
// Config comes from .agents/agy.env (template: telemetry/agy.env, gitignored): the OTLP endpoint,
// headers (the ingest key) and resource attributes (the seat). No file or no key: it does nothing.
// It never sends prompt text, tool arguments or tool output: only the tool name, model, step and
// whether it failed. Hooks block the agent loop, so the hook returns at once and a detached child
// does the network call; a failed send is dropped silently rather than disturbing the agent.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.AGY_TELEMETRY_ENV || path.join(ROOT, '.agents', 'agy.env');
const SERVICE_NAME = 'antigravity-cli';
const SEND_TIMEOUT_MS = 5000;

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

// KEY=value lines; # comments and blank lines ignored; no shell expansion.
export const parseEnvFile = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
};

// "a=1,b=2" (the OTEL_* list format) to { a: '1', b: '2' }.
const parseList = (s) =>
  Object.fromEntries(
    (s || '')
      .split(',')
      .map((kv) => kv.trim())
      .filter((kv) => kv.includes('='))
      .map((kv) => [kv.slice(0, kv.indexOf('=')).trim(), kv.slice(kv.indexOf('=') + 1).trim()]),
  );

const attr = (key, value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  if (typeof value === 'number') return { key, value: { doubleValue: value } };
  return { key, value: { stringValue: String(value) } };
};

const errorMessage = (e) => (typeof e === 'string' ? e : e?.message || (e ? JSON.stringify(e) : ''));

// One span per hook event. Exported for the tests.
export const buildRequest = (event, payload, cfg, nowNs = BigInt(Date.now()) * 1_000_000n) => {
  const conversation = payload.conversationId || 'unknown';
  const traceId = crypto.createHash('sha256').update(conversation).digest('hex').slice(0, 32);
  const spanId = crypto.randomBytes(8).toString('hex');
  const err = payload.error ? errorMessage(payload.error) : '';
  const tool = payload.toolCall?.name || payload.toolName;

  const names = { PostToolUse: 'agy.tool_result', PostInvocation: 'agy.invocation', Stop: 'agy.stop' };
  const name = names[event] || `agy.${event}`;

  const attributes = [
    attr('event.name', name),
    attr('conversation.id', payload.conversationId),
    attr('model', payload.modelName),
    attr('tool_name', event === 'PostToolUse' ? tool : undefined),
    attr('agy.step', payload.stepIdx),
    attr('agy.invocation', payload.invocationNum),
    attr('agy.termination_reason', payload.terminationReason),
    attr('error', err ? true : event === 'PostToolUse' ? false : undefined),
    attr('error.message', err ? err.slice(0, 500) : undefined),
  ].filter(Boolean);

  const resource = { 'service.name': SERVICE_NAME, ...parseList(cfg.OTEL_RESOURCE_ATTRIBUTES) };
  if (cfg.OTEL_SERVICE_NAME) resource['service.name'] = cfg.OTEL_SERVICE_NAME;

  const t = String(nowNs);
  return {
    resourceSpans: [
      {
        resource: { attributes: Object.entries(resource).map(([k, v]) => attr(k, v)).filter(Boolean) },
        scopeSpans: [
          {
            scope: { name: 'roast-judge-workshop/agy-hook' },
            spans: [
              {
                traceId,
                spanId,
                name,
                kind: 1,
                startTimeUnixNano: t,
                endTimeUnixNano: t,
                attributes,
                status: err ? { code: 2, message: err.slice(0, 500) } : { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  };
};

const loadConfig = () => {
  try {
    return parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    return null;
  }
};

const send = async (body) => {
  const cfg = loadConfig();
  const endpoint = (cfg.OTEL_EXPORTER_OTLP_ENDPOINT || 'https://api.honeycomb.io').replace(/\/+$/, '');
  await fetch(`${endpoint}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...parseList(cfg.OTEL_EXPORTER_OTLP_HEADERS) },
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
};

const main = async () => {
  const [event] = process.argv.slice(2);
  if (event === '--send') {
    await send(process.env.AGY_HOOK_BODY).catch(() => {});
    return;
  }
  const input = await readStdin();

  const cfg = loadConfig();
  if (!cfg || !cfg.OTEL_EXPORTER_OTLP_HEADERS || cfg.OTEL_EXPORTER_OTLP_HEADERS.includes('<KEY>')) return;

  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    return;
  }
  if (cfg.AGY_HOOK_DEBUG === '1') {
    fs.appendFileSync(path.join(path.dirname(ENV_FILE), 'agy-hook-debug.jsonl'), JSON.stringify({ event, cwd: process.cwd(), payload }) + '\n');
  }

  // The body goes in the environment, not a pipe: this process exits at once, and a pipe write
  // still in flight when it does is lost.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--send'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGY_HOOK_BODY: JSON.stringify(buildRequest(event, payload, cfg)) },
  });
  child.unref();
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {});
}
