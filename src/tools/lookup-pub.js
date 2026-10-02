'use strict';

// lookup_pub: asks the pub-guide service about a pub. Uses global fetch (undici), so the
// undici instrumentation gives a CLIENT span and propagates trace context to pub-guide.
// ctx.failTool swaps in the reserved slug the pub-guide always fails on.

const FAILING_SLUG = 'the-condemned-arms';

const name = 'lookup_pub';
const type = 'extension';

const definition = {
  type: 'function',
  name,
  description: 'Look up a pub in the pub guide by slug: name, price band, specialities and reputation.',
  parameters: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'The pub slug, e.g. "the-gravy-boat".' },
    },
    required: ['slug'],
  },
  strict: false,
};

async function execute(args = {}, ctx = {}) {
  const slug = ctx.failTool ? FAILING_SLUG : String(args.slug || '');
  const res = await fetch(`${ctx.pubGuideUrl}/pubs/${encodeURIComponent(slug)}`);
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    throw new Error(`lookup_pub: pub-guide returned ${res.status} for ${slug}`);
  }
  return res.json();
}

module.exports = { name, type, definition, execute };
