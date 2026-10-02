'use strict';

// checkpoint-0 (and 1, 2): auto-instrumentation only. HTTP, express, undici and the hand-written
// sqlite span are there; the openai instrumentation is off and the agent/tool spans are blank,
// so there are no gen_ai spans at all. Only the judge turn is checked.

const u = require('./_util.js');

const checks = [
  u.check('POST /judge SERVER span with http.route /judge', (ctx) => {
    const servers = u.turnSpans(ctx, 0).filter((s) => s.kind === u.KIND.SERVER);
    u.expect(servers.length > 0, 'missing span `POST /judge` (no SERVER span in the judge trace)');
    u.expect(servers.length === 1, `expected one SERVER span, found ${servers.length}`);
    u.expectAttr(servers, 'http.route', '/judge');
    u.expect(servers[0].name === 'POST /judge', `SERVER span is named \`${servers[0].name}\`, want \`POST /judge\``);
  }),
  u.check('express spans present', (ctx) => {
    const express = u.turnSpans(ctx, 0).filter((s) => u.attr(s, 'express.type') !== undefined);
    u.expect(express.length > 0, 'no express middleware / request handler spans');
  }),
  u.check('undici CLIENT span to the pub guide (/pubs/)', (ctx) => {
    u.expect(u.pubGuideSpans(u.turnSpans(ctx, 0)).length === 1, 'expected one CLIENT span whose url contains /pubs/');
  }),
  u.check('SELECT verdicts CLIENT span with db.system.name=sqlite', (ctx) => {
    const db = u.one(u.turnSpans(ctx, 0), 'SELECT verdicts');
    u.expectKind([db], 'CLIENT');
    u.expectAttr([db], 'db.system.name', 'sqlite');
  }),
  u.check('no gen_ai spans (no chat, invoke_agent or execute_tool)', (ctx) => {
    const spans = u.turnSpans(ctx, 0);
    u.expect(spans.length > 0, 'no spans in the judge trace');
    const gen = spans.filter((s) => u.attr(s, 'gen_ai.operation.name') !== undefined);
    u.expect(gen.length === 0, `found gen_ai spans: ${[...new Set(gen.map((s) => `\`${s.name}\``))].join(', ')}`);
  }),
];

module.exports = checks;
