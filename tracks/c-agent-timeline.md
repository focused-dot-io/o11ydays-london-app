# Track (c): Agent Timeline

**Goal:** stamp the conversation on your agent span, send a three-turn conversation (judge, appeal,
final ruling) and see all three turns, with their tools, on one Agent Timeline. About 15 minutes.

Start on `checkpoint-4` (`npm run catchup -- 4`) with the app running.

## Steps

### 1. Stamp the conversation

Open `src/agent.js` and find `withAgentSpan`. In the `attributes` passed to `startActiveSpan`
there is a marker:

```js
// TODO(module-4c): stamp gen_ai.conversation.id here (track c)
```

Add `gen_ai.conversation.id`, taken from the `conversation` argument's `id`, next to the attributes
already there. Keep `gen_ai.agent.name` (`roast-judge`) where it is: Agent Timeline uses it to
label the agent. Set both at span creation, in the options, not later with `setAttribute`: the
app's span processor copies them from the agent span onto every chat and `execute_tool` span as
they start, so the whole subtree carries the conversation.

Restart the app (`npm run dev`: Ctrl-C and start again; `docker compose up` reloads on save).

### 2. Check it

```bash
npm run verify -- main
```

`main`'s expectation set asserts that all three turns carry the same `gen_ai.conversation.id`; it
prints `PASS main`. (Plain `npm run verify` on this branch checks `checkpoint-4`'s set, which
asserts the id is *absent*, the state the branch shipped in, so after your change it fails on
purpose. `node scripts/verify.cjs main` is the same check as `npm run verify -- main`.)

### 3. Send a conversation

```bash
# Turn 1: the verdict. Keep the conversation_id it returns.
curl -s localhost:3000/judge -H 'content-type: application/json' \
  -d '{"text":"The Gravy Boat, £24, beef. Yorkshire the size of a hubcap but soggy underneath, gravy clearly from granules, roasties crisp."}'

CID=<paste the conversation_id here>

# Turn 2: the appeal. Re-scores the disputed component.
curl -s localhost:3000/judge/$CID/appeal -H 'content-type: application/json' \
  -d '{"text":"That Yorkshire was enormous, surely size counts for something."}'

# Turn 3: the final ruling, upheld or overturned.
curl -s -X POST localhost:3000/judge/$CID/final -H 'content-type: application/json' -d '{}'
```

With `jq` installed, turn 1 can capture the id for you:
`CID=$(curl -s localhost:3000/judge -H 'content-type: application/json' -d '{"text":"..."}' | jq -r .conversation_id)`.

Each response carries its own `trace_id`: three requests, three traces, one conversation.

### 4. Open Agent Timeline

In Honeycomb, open one of the three traces in `roast-judge-<seat>` and switch to Agent Timeline (or
query `gen_ai.conversation.id = <your id>` and open the timeline from there).

## The query that proves it (green sticky note)

Agent Timeline showing one conversation's three turns, with each turn's tools: turn 1 calls
`score_component` once per component plus `lookup_pub` and `compare_to_benchmarks`; the appeal calls
`score_component` again for the disputed Yorkshire; the final ruling calls `compare_to_benchmarks`.

Once your stamping is live, `npm run load` sends about 30% of its runs through all three turns, so
there are more conversations to browse.

## Teaching beat

**Never fabricate a conversation ID.** The spec says to set `gen_ai.conversation.id` only when you
have a real one. Here the app issues it when a judgement starts, stores the conversation, and the
client sends it back on later turns, so the id means "these turns really were one conversation". A
made-up id per request (a fresh UUID, the trace ID) would put a value on every span and bind nothing
together. A single trace waterfall can never show this: "what did the agent do?" can span more than
one request.

## If stuck

- **`npm run verify -- main` fails on the conversation id:** the id must go in the `attributes` of
  `startActiveSpan`, from `conversation.id`, not a new value per turn.
- **Turns 2 or 3 return 404:** the conversation lives in the app's memory; restarting the app (or a
  `node --watch` reload after an edit) forgets it. Start again from turn 1.
- **Only one turn on the timeline:** check the `conversation_id` you pasted matches turn 1's, and
  that all three requests went after your restart.
- **The answer:** `main`'s `src/agent.js` (`git show origin/main:src/agent.js`).
