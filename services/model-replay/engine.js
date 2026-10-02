'use strict';

// Deterministic, rule-based fake model for the OpenAI Responses API.
// respond(body, headers, options) -> { status, body, latencyMs }. Pure apart from the
// fail-every call counter and the random response id / created_at.

const crypto = require('node:crypto');
const { components, pubs, labelFor } = require('./vocabulary.js');

const REPLAY_MODEL = 'gpt-4.1-mini-2025-04-14';
const PROMPT_MARKER_RE = /<!--\s*roast-judge prompt (v\d+)\s*-->/;
const DEFAULT_COMPONENTS = ['meat', 'roasties', 'gravy'];
const UNKNOWN_PUB = 'unknown-pub';
const DEFAULT_FAIL_EVERY = 25;
const BAND_BASE = { premium: 8.4, mid: 6.6, budget: 4.6 };

const moduleCounter = { n: 0 };

// ------------------------------------------------------------------ hashing / seeding

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Seed for one (prompt version, turn, user text). Returns a hex string. */
function hashSeed(version, turn, text) {
  return sha(`${version}|${turn}|${text}`).slice(0, 32);
}

/** Deterministic float in [0, 1) derived from a seed and a label. */
function rand(seed, label) {
  return parseInt(sha(`${seed}|${label}`).slice(0, 12), 16) / 2 ** 48;
}

function round1(x) {
  return Math.round(Math.min(10, Math.max(0, x)) * 10) / 10;
}

// ------------------------------------------------------------------ keyword matching

function pubSpans(lower) {
  const spans = [];
  for (const p of pubs) {
    for (const k of p.keywords) {
      const kw = k.toLowerCase();
      let i = lower.indexOf(kw);
      while (i !== -1) {
        spans.push({ slug: p.slug, start: i, end: i + kw.length });
        i = lower.indexOf(kw, i + 1);
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Slug of the first pub mentioned in the text, or null. */
function detectPub(text) {
  const spans = pubSpans(String(text).toLowerCase());
  return spans.length ? spans[0].slug : null;
}

/** Lowercased text with every pub name blanked out, so pub names never count as components. */
function stripPubs(text) {
  let lower = String(text).toLowerCase();
  for (const s of pubSpans(lower)) {
    lower = lower.slice(0, s.start) + ' '.repeat(s.end - s.start) + lower.slice(s.end);
  }
  return lower;
}

/** Component ids mentioned in the text, in vocabulary order. */
function detectComponents(text) {
  const lower = stripPubs(text);
  return components.filter((c) => c.keywords.some((k) => lower.includes(k.toLowerCase()))).map((c) => c.id);
}

/** The component mentioned earliest in the text, or null. */
function firstComponentIn(text) {
  const lower = stripPubs(text);
  let best = null;
  for (const c of components) {
    for (const k of c.keywords) {
      const i = lower.indexOf(k.toLowerCase());
      if (i !== -1 && (!best || i < best.pos)) best = { id: c.id, pos: i };
    }
  }
  return best ? best.id : null;
}

// ------------------------------------------------------------------ reading the input

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && (p.text ?? p.content)) || '')).join('\n');
  }
  return '';
}

function safeJson(s) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function toolNameFromOutput(out) {
  if (!out || typeof out !== 'object') return null;
  if ('component' in out && 'score' in out) return 'score_component';
  if ('price_band' in out || 'found' in out) return 'lookup_pub';
  if ('pub_average' in out || 'overall_average' in out) return 'compare_to_benchmarks';
  return null;
}

/** Split the input into the developer prompt version and per-turn segments. */
function parseConversation(input) {
  const items = Array.isArray(input) ? input : typeof input === 'string' ? [{ role: 'user', content: input }] : [];
  let version = 'v1';
  for (const it of items) {
    if (it && (it.role === 'developer' || it.role === 'system')) {
      const m = PROMPT_MARKER_RE.exec(contentText(it.content));
      if (m) {
        version = m[1];
        break;
      }
    }
  }

  const callNames = new Map();
  for (const it of items) if (it && it.type === 'function_call') callNames.set(it.call_id, it.name);

  const turns = [];
  for (const it of items) {
    if (!it) continue;
    if (it.role === 'user') {
      turns.push({ text: contentText(it.content), outputs: [], verdict: null });
      continue;
    }
    const cur = turns[turns.length - 1];
    if (!cur) continue;
    if (it.type === 'function_call_output') {
      const out = safeJson(it.output);
      const name = callNames.get(it.call_id) || toolNameFromOutput(out);
      cur.outputs.push({ name, out });
    } else if (it.role === 'assistant' && (it.type === 'message' || it.type === undefined)) {
      const v = safeJson(contentText(it.content));
      if (v && typeof v.score === 'number') cur.verdict = v;
    }
  }
  return { version, turns };
}

// ------------------------------------------------------------------ the judge

function turnContext(version, conv, idx) {
  const first = conv.turns[0];
  const texts = conv.turns.slice(0, idx + 1).map((t) => t.text);
  const firstFound = detectComponents(first.text);
  return {
    version,
    turnNo: idx + 1,
    seg: conv.turns[idx],
    seed: hashSeed(version, idx + 1, texts.join('\n')),
    pub: detectPub(first.text) || UNKNOWN_PUB,
    components: firstFound.length ? firstFound : DEFAULT_COMPONENTS,
  };
}

function scoresFrom(outputs) {
  const scores = {};
  for (const o of outputs) {
    if (o.name === 'score_component' && o.out && typeof o.out.score === 'number') scores[o.out.component] = o.out.score;
  }
  return scores;
}

function bandFrom(outputs) {
  let band = null;
  for (const o of outputs) if (o.name === 'lookup_pub' && o.out && o.out.price_band) band = o.out.price_band;
  return BAND_BASE[band] !== undefined ? band : 'mid';
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 5;
}

function pretty(id) {
  return id === 'nut_roast' ? 'nut roast' : id;
}

function scoreList(scores) {
  return Object.entries(scores)
    .map(([k, v]) => `${pretty(k)} ${v}`)
    .join(', ');
}

/** The steps (one array of calls per model call) a turn takes before its verdict. */
function plan(ctx, conv) {
  const { version, turnNo, seed, pub } = ctx;
  if (version === 'v2') {
    if (turnNo === 1) {
      const steps = [[{ name: 'lookup_pub', args: { slug: pub } }]];
      if (rand(seed, 'double-lookup') < 0.4) steps.push([{ name: 'lookup_pub', args: { slug: pub } }]);
      if (rand(seed, 'score-one') < 0.45) {
        steps.push([{ name: 'score_component', args: { component: ctx.components[0], notes: 'Quick sanity check on the headline item.' } }]);
      }
      return steps;
    }
    if (turnNo === 2) return [[{ name: 'lookup_pub', args: { slug: pub } }]];
    return [[{ name: 'compare_to_benchmarks', args: { scores: latestScores(ctx, conv), pub } }]];
  }
  if (turnNo === 1) {
    return [
      [
        ...ctx.components.map((c) => ({ name: 'score_component', args: { component: c, notes: notesFor(c, ctx.seg.text) } })),
        { name: 'lookup_pub', args: { slug: pub } },
        { name: 'compare_to_benchmarks', args: { scores: {}, pub } },
      ],
    ];
  }
  if (turnNo === 2) {
    const disputed = disputedComponent(ctx);
    return [[{ name: 'score_component', args: { component: disputed, notes: `Appeal: ${ctx.seg.text}` } }]];
  }
  return [[{ name: 'compare_to_benchmarks', args: { scores: latestScores(ctx, conv), pub } }]];
}

function notesFor(component, text) {
  const comp = components.find((c) => c.id === component);
  const sentences = String(text).split(/(?<=[.!?,;])\s+/);
  const lower = (s) => stripPubs(s);
  const hit = sentences.find((s) => comp.keywords.some((k) => lower(s).includes(k)));
  return hit ? hit.trim() : `No specific comment on the ${pretty(component)}.`;
}

function disputedComponent(ctx) {
  return firstComponentIn(ctx.seg.text) || ctx.components[0];
}

function latestScores(ctx, conv) {
  const scores = {};
  for (let i = 0; i < ctx.turnNo; i++) Object.assign(scores, scoresFrom(conv.turns[i].outputs));
  return scores;
}

/** Verdict a given turn produces (turn index idx), reading previous verdicts where needed. */
function verdictFor(version, conv, idx) {
  const ctx = turnContext(version, conv, idx);
  const outs = ctx.seg.outputs;

  if (version === 'v2') {
    if (ctx.turnNo === 1) {
      const band = bandFrom(outs);
      const s = scoresFrom(outs);
      const vals = Object.values(s);
      const nudge = vals.length ? (mean(vals) - 6.5) * 0.15 : 0;
      const score = round1(BAND_BASE[band] + (rand(ctx.seed, 'jitter') - 0.5) * 1.2 + nudge);
      const pubName = (pubs.find((p) => p.slug === ctx.pub) || {}).name || 'this pub';
      const reason =
        `Trusting my instincts here: ${pubName} carries a ${band} reputation and, having checked it first, ` +
        `the plate reads very much in keeping with that standing. ${vals.length ? `A quick look at the ${pretty(Object.keys(s)[0])} backs this up. ` : ''}` +
        `Overall the experience feels ${labelFor(score) === 'banging' ? 'assured and confidently executed' : labelFor(score) === 'decent' ? 'solid, if not spectacular' : 'like a place cutting corners'}, ` +
        `and I am comfortable being decisive about it without picking apart every component.`;
      return { score, label: labelFor(score), reason };
    }
    const prev = previousVerdict(version, conv, idx - 1);
    if (ctx.turnNo === 2) {
      const score = round1(prev.score + (rand(ctx.seed, 'appeal') - 0.5) * 0.8);
      const reason =
        `I have re-checked the pub's reputation in light of your appeal. Its standing has not changed, and my ` +
        `instinct about the overall experience holds, so the verdict moves only marginally. Being decisive matters ` +
        `more than relitigating individual items on the plate.`;
      return { score, label: labelFor(score), reason };
    }
    return finalRuling(version, conv, idx, ctx, true);
  }

  if (ctx.turnNo === 1) {
    const s = scoresFrom(outs);
    const score = round1(mean(Object.values(s)));
    return { score, label: labelFor(score), reason: `Scored ${scoreList(s) || 'nothing'}; mean ${score.toFixed(1)}.` };
  }
  if (ctx.turnNo === 2) {
    const before = scoresFrom(conv.turns[0].outputs);
    const now = { ...before, ...scoresFrom(outs) };
    const disputed = disputedComponent(ctx);
    const score = round1(mean(Object.values(now)));
    const was = before[disputed];
    const rescored = now[disputed];
    return {
      score,
      label: labelFor(score),
      reason: `Re-scored ${pretty(disputed)}: ${was === undefined ? 'unscored' : was} -> ${rescored}. Now ${scoreList(now)}; mean ${score.toFixed(1)}.`,
    };
  }
  return finalRuling(version, conv, idx, ctx, false);
}

function previousVerdict(version, conv, idx) {
  return conv.turns[idx].verdict || verdictFor(version, conv, idx);
}

function finalRuling(version, conv, idx, ctx, wordy) {
  const t1 = previousVerdict(version, conv, 0);
  const t2 = idx >= 2 ? previousVerdict(version, conv, 1) : t1;
  const score = round1(t2.score);
  const ruling = Math.abs(t2.score - t1.score) >= 2 ? 'overturned' : 'upheld';
  const bench = (ctx.seg.outputs.find((o) => o.name === 'compare_to_benchmarks') || {}).out || {};
  const vs = typeof bench.pub_average === 'number' ? ` Pub average ${bench.pub_average}.` : '';
  const reason = wordy
    ? `Having weighed the pub's reputation against the benchmarks one final time, I am confident in this call. ` +
      `The original verdict was ${t1.score} and the appeal landed at ${t2.score}, so the ruling is ${ruling}.${vs} ` +
      `Decisiveness is a virtue in a judge and I stand by my instincts on this one.`
    : `Judged ${t1.score}, appeal ${t2.score}: ${ruling}.${vs}`;
  return { score, label: labelFor(score), reason, ruling };
}

// ------------------------------------------------------------------ response building

function approxTokens(s) {
  return Math.max(1, Math.ceil(String(s).length / 4));
}

function errorResult(message, latencyMs) {
  return { status: 500, body: { error: { message, type: 'server_error', param: null, code: null } }, latencyMs };
}

function respond(body, headers = {}, options = {}) {
  const env = options.env || process.env;
  const counter = options.callCounter || moduleCounter;
  counter.n += 1;

  const scaleRaw = env.REPLAY_LATENCY_SCALE;
  const scale = scaleRaw === undefined || scaleRaw === '' ? 1 : Number(scaleRaw);
  const failRaw = env.REPLAY_FAIL_EVERY;
  const failEvery = failRaw === undefined || failRaw === '' ? DEFAULT_FAIL_EVERY : Number(failRaw);

  const h = headers || {};
  const forced = ['1', 'true'].includes(String(h['x-replay-fail'] ?? '').toLowerCase());
  if (forced || (failEvery > 0 && counter.n % failEvery === 0)) {
    return errorResult(
      forced ? 'The server had an error while processing your request (forced by x-replay-fail).' : 'The server had an error while processing your request. Sorry about that!',
      scale > 0 ? Math.round(120 * scale) : 0,
    );
  }

  const input = body && body.input;
  const conv = parseConversation(input);
  if (conv.turns.length === 0) conv.turns.push({ text: '', outputs: [], verdict: null });
  const idx = Math.min(conv.turns.length, 3) - 1;
  // Beyond turn 3, treat the conversation as a repeated final ruling on the last segment.
  if (conv.turns.length > 3) conv.turns = [...conv.turns.slice(0, 2), conv.turns[conv.turns.length - 1]];
  const ctx = turnContext(conv.version, conv, idx);
  const steps = plan(ctx, conv);
  const step = ctx.seg.outputs.length === 0 ? 0 : conv.version === 'v2' ? ctx.seg.outputs.length : 1;

  const output = [];
  const stepSeed = `${ctx.seed}|step${step}`;
  if (step < steps.length) {
    steps[step].forEach((call, i) => {
      const h1 = sha(`${stepSeed}|${i}|${call.name}`);
      output.push({
        type: 'function_call',
        id: `fc_${h1.slice(0, 24)}`,
        call_id: `call_${h1.slice(24, 48)}`,
        name: call.name,
        arguments: JSON.stringify(call.args),
        status: 'completed',
      });
    });
  } else {
    const verdict = verdictFor(conv.version, conv, idx);
    output.push({
      type: 'message',
      id: `msg_${sha(`${stepSeed}|msg`).slice(0, 24)}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(verdict), annotations: [] }],
    });
  }

  const outText = output.map((o) => (o.type === 'message' ? o.content[0].text : o.name + o.arguments)).join('');
  const input_tokens = approxTokens(JSON.stringify(input ?? '')) + Math.floor(rand(stepSeed, 'in') * 24) + 40;
  const output_tokens = approxTokens(outText) + Math.floor(rand(stepSeed, 'out') * 16) + 5;
  const usage = { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens };

  const latencyMs =
    scale > 0 ? Math.max(1, Math.round((300 + 12 * output_tokens + 0.05 * input_tokens + rand(stepSeed, 'lat') * 250) * scale)) : 0;

  return {
    status: 200,
    body: {
      id: `resp_${crypto.randomBytes(12).toString('hex')}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: REPLAY_MODEL,
      status: 'completed',
      output,
      usage,
    },
    latencyMs,
  };
}

module.exports = {
  respond,
  hashSeed,
  PROMPT_MARKER_RE,
  REPLAY_MODEL,
  detectPub,
  detectComponents,
  firstComponentIn,
};
