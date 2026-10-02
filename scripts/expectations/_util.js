'use strict';

// Helpers shared by the expectation sets. Every helper works on both span shapes:
//   - ReadableSpan (sdk-trace-base, what verify.cjs collects in-process)
//   - the plain serialised object { name, kind, traceId, spanId, parentSpanId, status, attributes }
// Checks read only name, kind, attributes and status.code, and go through spanId()/parentId() for ids.

const KIND = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));

const AGENT = 'invoke_agent roast-judge';
const CHAT = 'chat gpt-4.1-mini';
const TOOL = (name) => `execute_tool ${name}`;

function spanId(span) {
  if (!span) return undefined;
  const ctx = typeof span.spanContext === 'function' ? span.spanContext() : undefined;
  return (ctx && ctx.spanId) ?? span.spanId;
}

function parentId(span) {
  if (!span) return undefined;
  return (span.parentSpanContext && span.parentSpanContext.spanId) ?? span.parentSpanId ?? undefined;
}

function byName(spans, name) {
  return (spans || []).filter((s) => s.name === name);
}

function attr(span, key) {
  return span && span.attributes ? span.attributes[key] : undefined;
}

function kindName(span) {
  return KIND_NAME[span && span.kind] || String(span && span.kind);
}

function isError(span) {
  return Boolean(span && span.status && span.status.code === 2);
}

/** The spans of turn i (0 judge, 1 appeal, 2 final), or [] when the turn is missing. */
function turnSpans(ctx, i = 0) {
  const turn = ctx && Array.isArray(ctx.turns) ? ctx.turns[i] : undefined;
  return (turn && Array.isArray(turn.spans) && turn.spans) || [];
}

const allSpans = (ctx) => (ctx && Array.isArray(ctx.turns) ? ctx.turns.flatMap((t) => (t && t.spans) || []) : []);

/** Thrown inside a check body to fail with a reason; check() turns it into the returned string. */
class CheckFailure extends Error {}

function fail(reason) {
  throw new CheckFailure(reason);
}

function expect(cond, reason) {
  if (!cond) fail(reason);
}

/** Exactly one span with this name in `spans`, else fail. */
function one(spans, name) {
  const found = byName(spans, name);
  if (found.length === 0) fail(`missing span \`${name}\``);
  if (found.length > 1) fail(`expected one \`${name}\` span, found ${found.length}`);
  return found[0];
}

/** At least `min` spans with this name, else fail. */
function atLeast(spans, name, min = 1) {
  const found = byName(spans, name);
  if (found.length === 0) fail(`missing span \`${name}\``);
  if (found.length < min) fail(`expected at least ${min} \`${name}\` spans, found ${found.length}`);
  return found;
}

/** Fails unless every span's parent is `parent`. */
function expectParent(spans, parent, parentLabel) {
  const pid = spanId(parent);
  for (const s of spans) {
    expect(parentId(s) === pid, `\`${s.name}\` is not a child of \`${parentLabel || parent.name}\` (parent ${parentId(s) || 'none'})`);
  }
}

function expectKind(spans, kind) {
  for (const s of spans) expect(s.kind === KIND[kind], `\`${s.name}\` has kind ${kindName(s)}, want ${kind}`);
}

function expectAttr(spans, key, want) {
  for (const s of spans) {
    const v = attr(s, key);
    if (typeof want === 'function') {
      expect(want(v), `\`${s.name}\` has ${key}=${JSON.stringify(v)}`);
    } else if (want === undefined) {
      expect(v !== undefined && v !== null && v !== '', `\`${s.name}\` has no ${key}`);
    } else {
      expect(v === want, `\`${s.name}\` has ${key}=${JSON.stringify(v)}, want ${JSON.stringify(want)}`);
    }
  }
}

/** The undici CLIENT span that fetched a pub from the pub guide (turn 1), or undefined. */
function pubGuideSpans(spans) {
  return (spans || []).filter((s) => {
    const url = attr(s, 'url.full') || attr(s, 'url.path') || '';
    return s.kind === KIND.CLIENT && String(url).includes('/pubs/');
  });
}

/**
 * Wraps a check body so it never throws: it returns true, or a non-empty reason string.
 * The body may return true / a string, or call fail()/expect().
 */
function check(name, body) {
  return {
    name,
    check(ctx) {
      try {
        const r = body(ctx || {});
        if (r === undefined || r === true) return true;
        return typeof r === 'string' && r.length > 0 ? r : `check returned ${JSON.stringify(r)}`;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        return msg || 'check failed';
      }
    },
  };
}

module.exports = {
  KIND,
  AGENT,
  CHAT,
  TOOL,
  spanId,
  parentId,
  byName,
  attr,
  kindName,
  isError,
  turnSpans,
  allSpans,
  fail,
  expect,
  one,
  atLeast,
  expectParent,
  expectKind,
  expectAttr,
  pubGuideSpans,
  check,
};
