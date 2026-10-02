'use strict';

// Loaded with `node --require ./src/telemetry.js` so instrumentation patches modules
// before the app requires them. Env:
//   ROASTJUDGE_EXPORTER=otlp|console|memory (default otlp)
//   HONEYCOMB_API_KEY, HONEYCOMB_ENDPOINT (default https://api.eu1.honeycomb.io)
//   SEAT (default 0), OTEL_SERVICE_NAME (override), REPLAY_URL
//   OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true to copy prompts/completions onto chat spans

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
} = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
const { OpenAIInstrumentation } = require('@opentelemetry/instrumentation-openai');
const {
  InheritAttributesSpanProcessor,
  ContentToSpanLogProcessor,
  INHERITED_KEYS,
} = require('./telemetry/processors.js');

const seat = process.env.SEAT || '0';
const serviceName = process.env.OTEL_SERVICE_NAME || `roast-judge-${seat}`;

let mode = (process.env.ROASTJUDGE_EXPORTER || 'otlp').toLowerCase();
if (mode === 'otlp' && !process.env.HONEYCOMB_API_KEY) {
  process.stderr.write(
    [
      '',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '!!  HONEYCOMB_API_KEY is not set: traces will NOT reach Honeycomb.',
      '!!  Printing spans to the console instead.',
      '!!  Fix:  npm run setup -- --seat N --key K',
      '!!        (N = your seat number, K = your Honeycomb ingest key)',
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      '',
      '',
    ].join('\n'),
  );
  mode = 'console';
}

let memoryExporter = null;
let exportingProcessor;
if (mode === 'memory') {
  memoryExporter = new InMemorySpanExporter();
  exportingProcessor = new SimpleSpanProcessor(memoryExporter);
} else if (mode === 'console') {
  exportingProcessor = new SimpleSpanProcessor(new ConsoleSpanExporter());
} else {
  const endpoint = (process.env.HONEYCOMB_ENDPOINT || 'https://api.eu1.honeycomb.io').replace(/\/+$/, '');
  exportingProcessor = new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY },
    }),
  );
}

const captureContent =
  String(process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT || '').toLowerCase() === 'true';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': serviceName, seat }),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new UndiciInstrumentation(),
    new OpenAIInstrumentation(), // Module 2: the one-liner
  ],
  spanProcessors: [new InheritAttributesSpanProcessor(), exportingProcessor],
  logRecordProcessors: captureContent ? [new ContentToSpanLogProcessor()] : [],
  metricReaders: [],
});

sdk.start();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    sdk
      .shutdown()
      .catch((err) => console.error('telemetry shutdown failed:', err))
      .finally(() => process.exit(0));
  });
}

module.exports = { sdk, memoryExporter, InheritAttributesSpanProcessor, ContentToSpanLogProcessor, INHERITED_KEYS };
