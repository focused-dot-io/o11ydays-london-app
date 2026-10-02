'use strict';

// checkpoint-4: same app code as checkpoint-3, with gen_ai.conversation.id blank for track (c).

const u = require('./_util.js');

module.exports = [
  ...require('./checkpoint-3.js'),
  u.check('gen_ai.conversation.id absent on all spans (track c)', (ctx) => {
    const spans = u.allSpans(ctx);
    u.expect(spans.length > 0, 'no spans collected');
    const stamped = spans.filter((s) => u.attr(s, 'gen_ai.conversation.id') !== undefined);
    u.expect(stamped.length === 0, `gen_ai.conversation.id is already set on ${[...new Set(stamped.map((s) => `\`${s.name}\``))].join(', ')} (track (c) starts with it blank)`);
  }),
];
