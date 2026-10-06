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
  return tracer.startActiveSpan(
    `invoke_agent ${AGENT_NAME}`,
    {
      kind: SpanKind.INTERNAL,
      // Set at creation, not later: samplers (and our inherit processor) read them at span start.
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': AGENT_NAME,
        // Module 3: stamp the prompt version so BubbleUp can find it
        'gen_ai.prompt.name': PROMPT_NAME,
        'gen_ai.prompt.version': promptVersion,
        // Module 4 track (c): a real conversation id, issued by the app
        // TODO(module-4c): stamp gen_ai.conversation.id here (track c)
        //   The app issues a real id when a judgement starts; it is on the `conversation`
        //   argument. Never make one up. See tracks/c-agent-timeline.md.
      },
    },
    async (span) => {
      try {
        const verdict = await run();
        // Module 3: the decision outcome
        span.setAttributes({
          'roastjudge.verdict.score': verdict.score,
          'roastjudge.verdict.label': verdict.label,
          'roastjudge.components_scored': verdict.components_scored,
        });
        return verdict;
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.setAttribute('error.type', errorType(err));
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Module 2: the tool span. One `execute_tool {name}` span per tool call; the call id ties it to
// the model's request for it.

function withToolSpan(tool, item, run) {
  return tracer.startActiveSpan(
    `execute_tool ${tool.name}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': tool.name,
        'gen_ai.tool.call.id': item.call_id,
        'gen_ai.tool.type': tool.type,
      },
    },
    async (span) => {
      try {
        return await run();
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.setAttribute('error.type', errorType(err));
        throw err;
      } finally {
        span.end();
      }
    },
  );
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
