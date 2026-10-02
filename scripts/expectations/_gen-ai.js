'use strict';

// Building blocks shared by checkpoint-2-cut, module-2, checkpoint-3/4 and main.
// All of them read the judge turn (ctx.turns[0]) unless stated otherwise.

const u = require('./_util.js');

const agentOf = (ctx) => u.one(u.turnSpans(ctx, 0), u.AGENT);
const chatsOf = (ctx) => u.atLeast(u.turnSpans(ctx, 0), u.CHAT, 2);

/** invoke_agent + chat: what the openai one-liner and Bite 1 give you. */
const agentChecks = [
  u.check('invoke_agent roast-judge: one INTERNAL span with gen_ai.operation.name and gen_ai.agent.name', (ctx) => {
    const agent = agentOf(ctx);
    u.expectKind([agent], 'INTERNAL');
    u.expectAttr([agent], 'gen_ai.operation.name', 'invoke_agent');
    u.expectAttr([agent], 'gen_ai.agent.name', 'roast-judge');
  }),
  u.check('chat gpt-4.1-mini: at least two CLIENT spans, children of invoke_agent', (ctx) => {
    const chats = chatsOf(ctx);
    u.expectKind(chats, 'CLIENT');
    u.expectParent(chats, agentOf(ctx), u.AGENT);
  }),
  u.check('chat spans carry provider, models, usage and finish_reasons', (ctx) => {
    const chats = chatsOf(ctx);
    u.expectAttr(chats, 'gen_ai.provider.name', 'openai');
    u.expectAttr(chats, 'gen_ai.request.model', 'gpt-4.1-mini');
    u.expectAttr(chats, 'gen_ai.response.model');
    u.expectAttr(chats, 'gen_ai.usage.input_tokens', (v) => typeof v === 'number');
    u.expectAttr(chats, 'gen_ai.usage.output_tokens', (v) => typeof v === 'number');
    u.expectAttr(chats, 'gen_ai.response.finish_reasons', (v) => Array.isArray(v) && v.length > 0);
  }),
];

const TOOLS = [
  { name: 'score_component', type: 'function', min: 1 },
  { name: 'lookup_pub', type: 'extension', exactly: 1 },
  { name: 'compare_to_benchmarks', type: 'datastore', exactly: 1 },
];

/** execute_tool: what Bite 2 gives you. */
const toolChecks = [
  ...TOOLS.map((t) =>
    u.check(`execute_tool ${t.name}: ${t.exactly ? 'one' : 'at least one'} INTERNAL span under invoke_agent, gen_ai.tool.type=${t.type}`, (ctx) => {
      const spans = t.exactly ? [u.one(u.turnSpans(ctx, 0), u.TOOL(t.name))] : u.atLeast(u.turnSpans(ctx, 0), u.TOOL(t.name), t.min);
      u.expectKind(spans, 'INTERNAL');
      u.expectParent(spans, agentOf(ctx), u.AGENT);
      u.expectAttr(spans, 'gen_ai.operation.name', 'execute_tool');
      u.expectAttr(spans, 'gen_ai.tool.name', t.name);
      u.expectAttr(spans, 'gen_ai.tool.type', t.type);
    }),
  ),
  u.check('execute_tool spans: gen_ai.tool.call.id set and unique', (ctx) => {
    const tools = u.turnSpans(ctx, 0).filter((s) => s.name.startsWith('execute_tool '));
    u.expect(tools.length > 0, 'missing span `execute_tool score_component` (no execute_tool spans)');
    u.expectAttr(tools, 'gen_ai.tool.call.id', (v) => typeof v === 'string' && v.length > 0);
    const ids = tools.map((s) => u.attr(s, 'gen_ai.tool.call.id'));
    u.expect(new Set(ids).size === ids.length, `gen_ai.tool.call.id values repeat: ${JSON.stringify(ids)}`);
  }),
  u.check('pub guide CLIENT span is a child of execute_tool lookup_pub', (ctx) => {
    const spans = u.turnSpans(ctx, 0);
    const pub = u.pubGuideSpans(spans);
    u.expect(pub.length === 1, 'expected one CLIENT span whose url contains /pubs/');
    u.expectParent(pub, u.one(spans, u.TOOL('lookup_pub')));
  }),
  u.check('SELECT verdicts is a child of execute_tool compare_to_benchmarks', (ctx) => {
    const spans = u.turnSpans(ctx, 0);
    u.expectParent([u.one(spans, 'SELECT verdicts')], u.one(spans, u.TOOL('compare_to_benchmarks')));
  }),
  u.check('chat finish_reasons: first asks for a tool_call, last says stop', (ctx) => {
    const chats = chatsOf(ctx);
    const first = u.attr(chats[0], 'gen_ai.response.finish_reasons') || [];
    const last = u.attr(chats[chats.length - 1], 'gen_ai.response.finish_reasons') || [];
    u.expect(Array.isArray(first) && first.includes('tool_call'), `first chat finish_reasons ${JSON.stringify(first)} has no tool_call`);
    u.expect(Array.isArray(last) && last.includes('stop'), `last chat finish_reasons ${JSON.stringify(last)} has no stop`);
  }),
];

/** Module 3 stamping: prompt and verdict attributes. */
const module3Checks = [
  u.check('invoke_agent carries gen_ai.prompt.name and gen_ai.prompt.version', (ctx) => {
    const agent = agentOf(ctx);
    u.expectAttr([agent], 'gen_ai.prompt.name', 'roast-judge');
    u.expectAttr([agent], 'gen_ai.prompt.version', (v) => v === 'v1' || v === 'v2');
  }),
  u.check('invoke_agent carries roastjudge.verdict.score, .label and roastjudge.components_scored', (ctx) => {
    const agent = agentOf(ctx);
    u.expectAttr([agent], 'roastjudge.verdict.score', (v) => typeof v === 'number');
    u.expectAttr([agent], 'roastjudge.verdict.label', (v) => typeof v === 'string' && v.length > 0);
    u.expectAttr([agent], 'roastjudge.components_scored', (v) => typeof v === 'number');
  }),
  u.check("chat spans inherit invoke_agent's gen_ai.prompt.name and gen_ai.prompt.version", (ctx) => {
    const agent = agentOf(ctx);
    const chats = chatsOf(ctx);
    u.expectAttr(chats, 'gen_ai.prompt.name', u.attr(agent, 'gen_ai.prompt.name') ?? '(set on invoke_agent)');
    u.expectAttr(chats, 'gen_ai.prompt.version', u.attr(agent, 'gen_ai.prompt.version') ?? '(set on invoke_agent)');
  }),
  u.check('chat spans carry roastjudge.model.replay=true', (ctx) => {
    u.expectAttr(chatsOf(ctx), 'roastjudge.model.replay', true);
  }),
];

module.exports = { agentChecks, toolChecks, module3Checks, agentOf, chatsOf };
