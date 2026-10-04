# Track (a): content capture

**Goal:** turn on message-content capture, read a roast conversation inside your chat spans, turn
it off again and watch the content vanish. About 8 minutes. Local, one flag, nothing external.

Start on `checkpoint-4` (`npm run catchup -- 4`) with the app running and your load generator going.

## Steps

1. **Flip it on.** In `.env`, add (or uncomment) this line:

   ```bash
   OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
   ```

2. **Restart the app** so it rereads `.env`:
   - `npm run dev` (the Codespace): `npm run restart`;
   - `docker compose up`: `docker compose up -d roast-judge` (recreates the container with the new
     `.env`; `node --watch` alone does not reread it).

3. **Send a request** and note its trace ID:

   ```bash
   npm run first-trace
   ```

4. **Read it.** Open that trace in `roast-judge-<seat>`. Click each `chat gpt-4.1-mini` span and find
   `gen_ai.input.messages` (the developer prompt, the roast, the tool results) and
   `gen_ai.output.messages` (the tool calls the model asked for, then the verdict JSON). Read down the
   waterfall: the whole conversation, one model call at a time.

5. **Flip it off.** Set the line back to `false` (or delete it), restart as in step 2, run
   `npm run first-trace` again. The new trace has the same shape, tokens and timings, and no message
   content.

## The query that proves it (green sticky note)

Open one trace with capture on and read the conversation across its chat spans. Then paste this
into the query builder on your dataset (last 30 minutes):

```json
{
  "time_range": 1800,
  "calculations": [{ "op": "COUNT" }],
  "filters": [
    { "column": "name", "op": "starts-with", "value": "chat" },
    { "column": "gen_ai.input.messages", "op": "exists" }
  ]
}
```

The count rises while capture is on and drops to zero after you turn it off.

## Teaching beat

Message content is **Opt-In** in the GenAI conventions: `gen_ai.input.messages` and
`gen_ai.output.messages` are the spec's "Opt-In" requirement level, and the instrumentation's
default is off. Three reasons:

- **Privacy.** Prompts carry whatever your users typed and whatever your tools returned: names,
  addresses, account numbers. Once it is in your telemetry it is in your retention, your access
  controls and your vendor's hands.
- **Cost.** Message content is by far the largest thing on a span. Every turn resends the whole
  history, so it grows with conversation length.
- **It is a deliberate decision.** You turn it on for a debugging window or a sampled slice, not by
  accident.

A detail worth knowing: `instrumentation-openai` does not put content on span attributes at all. It
emits it as **log records** through the OpenTelemetry Logs API, correlated to the chat span. With no
LoggerProvider configured, turning capture on does nothing visible. This app registers a small log
processor (`ContentToSpanLogProcessor` in `src/telemetry/processors.js`) that copies those two
attributes onto the still-open chat span as JSON strings, so you can read them in the trace
waterfall. In your own app you would send the logs to Honeycomb instead and correlate by trace ID.

## If stuck

- **No content after flipping on:** the app did not restart, or the value is not exactly `true`.
  `grep CAPTURE .env`, then `npm run restart`. Under Docker, `docker compose up -d roast-judge`, not a file save.
- **No chat spans at all:** you are not on `checkpoint-4`; `npm run catchup -- 4` and restart.
- **Content still there after flipping off:** you are looking at an older trace. Check the trace
  ID `first-trace` printed this time.
- **Want to see it without Honeycomb:** `ROASTJUDGE_EXPORTER=console` in `.env` prints spans to the
  app's terminal.
