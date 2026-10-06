'use strict';

// Roast Judge's agent: a hand-written loop over the OpenAI Responses API.
//
//   1. send the developer prompt + the conversation so far + the punter's text, with three tools
//   2. run every function_call the model asks for and feed each result back as function_call_output
//   3. repeat until the model answers with a message: that message is the verdict JSON
//
// The model calls are auto-instrumented (`chat gpt-4.1-mini` spans from instrumentation-openai).
// The agent run and each tool execution are instrumented by hand, in withAgentSpan() and
// withToolSpan() below: that is the Module 2 exercise (Module 3 and 4 add attributes to it).

const { trace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { getPrompt } = require('./prompts.js');
const { REQUEST_MODEL } = require('./model-client.js');
const scoreComponent = require('./tools/score-component.js');
const lookupPub = require('./tools/lookup-pub.js');
const benchmarks = require('./tools/benchmarks.js');

const AGENT_NAME = 'roast-judge';
const PROMPT_NAME = 'roast-judge';

const TOOLS = [scoreComponent, lookupPub, benchmarks];
const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const tracer = trace.getTracer('roast-judge');

class VerdictParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerdictParseError';
  }
}

const errorType = (err) => (err && err.constructor && err.constructor.name) || 'Error';

// ---------------------------------------------------------------------------------------------
// Module 2: the agent span. One `invoke_agent roast-judge` span per agent run; the chat and
// execute_tool spans nest inside it.

function withAgentSpan({ conversation, promptVersion }, run) {
  // TODO(module-2): create the `invoke_agent roast-judge` span around run() (Module 2, bite 2).
  //   - tracer.startActiveSpan(name, options, async (span) => { ... }) makes it the active span,
  //     so the chat and execute_tool spans started inside run() nest under it
  //   - name: `invoke_agent ${AGENT_NAME}`, kind: SpanKind.INTERNAL
  //   - attributes, passed in the options so they exist at span start (samplers, and the inherit
  //     processor in telemetry.js, read them there):
  //       gen_ai.operation.name = 'invoke_agent'
  //       gen_ai.agent.name     = AGENT_NAME
  //   - on failure: span.recordException(err), ERROR status, error.type = errorType(err), rethrow
  //   - always end the span (finally), and return run()'s verdict
  //   Leave the prompt and verdict attributes for Module 3, and gen_ai.conversation.id for
  //   Module 4 track (c).
  return run();
}

// ---------------------------------------------------------------------------------------------
// Module 2: the tool span. One `execute_tool {name}` span per tool call; the call id ties it to
// the model's request for it.

function withToolSpan(tool, item, run) {
  // TODO(module-2): create an `execute_tool <tool name>` span around run(), one per tool call.
  //   - name: `execute_tool ${tool.name}`, kind: SpanKind.INTERNAL; return what run() returns
  //   - attributes at span start:
  //       gen_ai.operation.name = 'execute_tool'
  //       gen_ai.tool.name      = the tool's name
  //       gen_ai.tool.call.id   = the call id on `item` (ties the model's ask to this execution)
  //       gen_ai.tool.type      = the tool's type (function / extension / datastore)
  //   - on failure: span.recordException(err), ERROR status, error.type = errorType(err), rethrow
  //     (`?fail=tool` makes lookup_pub fail so you can check it)
  //   - always end the span (finally)
  return run();
}

// ---------------------------------------------------------------------------------------------
// The agent loop (no telemetry in here: the spans above wrap it).

/** Runs one tool call and returns the function_call_output item. A failing tool does not end the run. */
async function callTool(item, ctx) {
  let result;
  try {
    const tool = TOOLS_BY_NAME.get(item.name);
    if (!tool) throw new Error(`unknown tool "${item.name}"`);
    const args = JSON.parse(item.arguments || '{}');
    result = await withToolSpan(tool, item, () => tool.execute(args, ctx));
  } catch (err) {
    // Tell the model what went wrong and let it carry on to a verdict.
    result = { error: String(err.message) };
  }
  return { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) };
}

function parseVerdict(response) {
  const messages = response.output.filter((item) => item.type === 'message');
  const message = messages[messages.length - 1];
  const part = message && Array.isArray(message.content) ? message.content[0] : undefined;
  const text = part && typeof part.text === 'string' ? part.text : '';
  let verdict;
  try {
    verdict = JSON.parse(text);
  } catch {
    throw new VerdictParseError(`the model's verdict is not JSON: ${JSON.stringify(text.slice(0, 200))}`);
  }
  if (!verdict || typeof verdict !== 'object' || verdict.score === undefined || verdict.label === undefined) {
    throw new VerdictParseError(`the model's verdict is missing score or label: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return verdict;
}

async function agentLoop({ conversation, turn, text, client, promptVersion, pubGuideUrl, failTool, failModel }) {
  const developer = { role: 'developer', content: getPrompt(promptVersion) };
  const history = conversation.turns.flatMap((t) => t.items);
  const items = [{ role: 'user', content: text }]; // this turn's items
  const ctx = { pubGuideUrl, failTool };
  const options = failModel ? { headers: { 'x-replay-fail': '1' } } : undefined;
  const tools = TOOLS.map((t) => t.definition);

  let modelCalls = 0;
  let componentsScored = 0;
  for (;;) {
    modelCalls += 1;
    const response = await client.responses.create(
      { model: REQUEST_MODEL, input: [developer, ...history, ...items], tools },
      options,
    );
    items.push(...response.output);

    const calls = response.output.filter((item) => item.type === 'function_call');
    if (calls.length === 0) {
      const { score, label, reason, ruling } = parseVerdict(response);
      const verdict = { score, label, reason };
      if (ruling !== undefined) verdict.ruling = ruling;
      // Record the turn on the conversation so the next turn replays it as history.
      conversation.turns.push({ turn, text, items, verdict });
      return { ...verdict, components_scored: componentsScored, model_calls: modelCalls };
    }

    for (const call of calls) {
      if (call.name === scoreComponent.name) componentsScored += 1;
      items.push(await callTool(call, ctx));
    }
  }
}

/**
 * One agent run (one turn: 1 judge, 2 appeal, 3 final ruling).
 * @returns {Promise<{ score, label, reason, ruling?, components_scored, model_calls }>}
 */
function runAgent(params) {
  return withAgentSpan(params, () => agentLoop(params));
}

module.exports = { runAgent, VerdictParseError, TOOLS, AGENT_NAME };
