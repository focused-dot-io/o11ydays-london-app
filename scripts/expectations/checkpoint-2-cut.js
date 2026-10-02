'use strict';

// checkpoint-2-cut: Module 2 halfway. The openai one-liner is in and invoke_agent is filled, but the
// execute_tool wrapper is still blank. Says nothing about Module 3 attributes either way.

const u = require('./_util.js');
const { agentChecks } = require('./_gen-ai.js');

module.exports = [
  ...agentChecks,
  u.check('no execute_tool spans yet', (ctx) => {
    const spans = u.turnSpans(ctx, 0);
    u.expect(spans.length > 0, 'no spans in the judge trace');
    const tools = spans.filter((s) => s.name.startsWith('execute_tool') || u.attr(s, 'gen_ai.operation.name') === 'execute_tool');
    u.expect(tools.length === 0, `found ${tools.length} execute_tool spans (this checkpoint ships them blank)`);
  }),
  u.check('undici CLIENT span to the pub guide (/pubs/)', (ctx) => {
    u.expect(u.pubGuideSpans(u.turnSpans(ctx, 0)).length === 1, 'expected one CLIENT span whose url contains /pubs/');
  }),
  u.check('SELECT verdicts CLIENT span with db.system.name=sqlite', (ctx) => {
    const db = u.one(u.turnSpans(ctx, 0), 'SELECT verdicts');
    u.expectKind([db], 'CLIENT');
    u.expectAttr([db], 'db.system.name', 'sqlite');
  }),
];
