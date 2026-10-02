'use strict';

// Test helper (no `.test.js` suffix): simulates the checkpoint blanks on a COPY of the repo, so the
// verify / check-spans CLIs can be exercised against checkpoint-shaped trees without the
// checkpoint overlays existing yet.
//
// CONTRACT the implementer must keep in src/ (ASSUMPTIONS beyond SPEC.md):
//   - src/telemetry.js registers the openai instrumentation on ONE line that contains the text
//     `new OpenAIInstrumentation()` and nothing else that matters: deleting that whole line leaves
//     a valid file with no openai instrumentation (no `chat gpt-4.1-mini` spans).
//   - src/agent.js declares `function withAgentSpan(` and `function withToolSpan(` (plain function
//     declarations), each taking the callback as a parameter named `run`. Replacing either body with
//     `{ return run(); }` must leave a working app that simply emits no `invoke_agent` /
//     `execute_tool` spans (the pass-through blank a checkpoint overlay would ship).
//   - src/agent.js stamps the conversation id on ONE line matching /'gen_ai\.conversation\.id'\s*:/;
//     deleting that line leaves a working app with no gen_ai.conversation.id on any span (the
//     checkpoint-4 shape; the inherit processor only copies what the parent has).

const fs = require('node:fs');
const path = require('node:path');

/** Index of the brace matching the `{` at `open` (skips strings, template literals and comments). */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && next === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      for (i += 1; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`blank-spans: unbalanced braces from offset ${open}`);
}

/** Replaces the body of `function <fnName>(...) { ... }` with `{ return run(); }`. */
function passThrough(src, fnName) {
  const sig = `function ${fnName}(`;
  const at = src.indexOf(sig);
  if (at === -1) throw new Error(`blank-spans: \`${sig}\` not found in src/agent.js`);
  // Skip the parameter list (may contain destructuring braces) to the body's opening brace.
  let i = at + sig.length;
  let parens = 1;
  for (; i < src.length && parens > 0; i++) {
    if (src[i] === '(') parens++;
    if (src[i] === ')') parens--;
  }
  const params = src.slice(at + sig.length, i - 1);
  if (!/\brun\b/.test(params)) throw new Error(`blank-spans: ${fnName} has no \`run\` parameter`);
  const open = src.indexOf('{', i);
  const close = matchBrace(src, open);
  return `${src.slice(0, open)}{\n  return run();\n}${src.slice(close + 1)}`;
}

function edit(file, fn) {
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`blank-spans: no change made to ${file}`);
  fs.writeFileSync(file, after);
}

/** Deletes the line containing `new OpenAIInstrumentation()` from <root>/src/telemetry.js. */
function blankOpenAI(root) {
  edit(path.join(root, 'src', 'telemetry.js'), (s) => s.replace(/^.*new OpenAIInstrumentation\(\).*\r?\n/m, ''));
}

/** Makes withAgentSpan a pass-through in <root>/src/agent.js. */
function blankAgentSpan(root) {
  edit(path.join(root, 'src', 'agent.js'), (s) => passThrough(s, 'withAgentSpan'));
}

/** Makes withToolSpan a pass-through in <root>/src/agent.js. */
function blankToolSpan(root) {
  edit(path.join(root, 'src', 'agent.js'), (s) => passThrough(s, 'withToolSpan'));
}

/** Deletes the `'gen_ai.conversation.id': ...` line from <root>/src/agent.js. */
function blankConversationId(root) {
  edit(path.join(root, 'src', 'agent.js'), (s) => s.replace(/^.*'gen_ai\.conversation\.id'\s*:.*\r?\n/m, ''));
}

module.exports = { blankOpenAI, blankAgentSpan, blankToolSpan, blankConversationId, passThrough, matchBrace };
