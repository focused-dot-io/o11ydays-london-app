'use strict';

// main: the complete reference. Everything checkpoint-3 checks, plus one conversation id shared by
// the judge, appeal and final turns.

const u = require('./_util.js');

const ROUTES = ['/judge', '/judge/:id/appeal', '/judge/:id/final'];

module.exports = [
  ...require('./checkpoint-3.js'),
  u.check('http.route per turn: /judge, /judge/:id/appeal, /judge/:id/final', (ctx) => {
    ROUTES.forEach((route, i) => {
      const servers = u.turnSpans(ctx, i).filter((s) => s.kind === u.KIND.SERVER);
      u.expect(servers.length === 1, `turn ${i + 1}: expected one SERVER span, found ${servers.length}`);
      u.expectAttr(servers, 'http.route', route);
    });
  }),
  u.check('gen_ai.conversation.id equal across all three turns (invoke_agent and chat spans)', (ctx) => {
    const ids = new Set();
    for (let i = 0; i < 3; i++) {
      const spans = u.turnSpans(ctx, i);
      const gen = [...u.byName(spans, u.AGENT), ...u.byName(spans, u.CHAT)];
      u.expect(u.byName(spans, u.AGENT).length === 1, `turn ${i + 1}: missing span \`${u.AGENT}\``);
      u.expect(u.byName(spans, u.CHAT).length > 0, `turn ${i + 1}: missing span \`${u.CHAT}\``);
      for (const s of gen) {
        const v = u.attr(s, 'gen_ai.conversation.id');
        u.expect(typeof v === 'string' && v.length > 0, `turn ${i + 1}: \`${s.name}\` has no gen_ai.conversation.id`);
        ids.add(v);
      }
    }
    u.expect(ids.size === 1, `gen_ai.conversation.id differs between turns: ${JSON.stringify([...ids])}`);
  }),
];
