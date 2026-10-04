# Track (b): cost and an alert on agent behaviour

**Goal:** turn token counts into money per prompt version, and put an alert on what the agent
*does*, so the next bad prompt pages you instead of waiting for a BubbleUp hunt. About 15 minutes.

Start on `checkpoint-4` (`npm run catchup -- 4`) with the app and `npm run load` running. Your
dataset already holds v1 and v2 traffic from Module 3.

## Steps

### 1. A cost calculated field

In Honeycomb, open your dataset `roast-judge-<seat>` → Dataset settings → Definitions → Derived
columns → New. Name it `roastjudge.cost_usd`:

```
IF(EQUALS($gen_ai.request.model, "gpt-4.1-mini"), ($gen_ai.usage.input_tokens * 0.40 + $gen_ai.usage.output_tokens * 1.60) / 1000000, 0)
```

The prices ($0.40 per million input tokens, $1.60 per million output tokens) are **illustrative**:
check your provider's current price list before you put a number like this in front of finance. The
`IF` keeps other models at 0 rather than pricing them wrongly; add a branch per model you run.

The usage attributes live on the auto-generated `chat gpt-4.1-mini` spans. Those spans also carry
`gen_ai.prompt.version`, copied from your `invoke_agent` span by the app's span processor (Module 3).

### 2. Cost by prompt version

Paste this into the query builder on your dataset. The last 90 minutes reaches back to Module 3.
It totals cost and counts runs (traces) per prompt version, then divides (per 1,000 runs, because a
single run costs a fraction of a tenth of a cent and rounds to 0.00):

```json
{
  "time_range": 5400,
  "calculations": [
    { "op": "SUM", "column": "roastjudge.cost_usd", "name": "cost" },
    { "op": "COUNT_DISTINCT", "column": "trace.trace_id", "name": "runs" },
    { "op": "COUNT", "name": "calls" }
  ],
  "formulas": [
    { "name": "usd_per_1000_runs", "expression": "$cost / $runs * 1000" },
    { "name": "model_calls_per_run", "expression": "$calls / $runs" }
  ],
  "filters": [{ "column": "name", "op": "starts-with", "value": "chat" }],
  "breakdowns": ["gen_ai.prompt.version"]
}
```

Spans from before you stamped show up as a blank `gen_ai.prompt.version` row. Ignore it. Add
`root.http.route` to the breakdowns to split first verdicts (`/judge`) from appeals and finals.

Compare per run, not the plain `SUM`: the sum mostly tells you how long each version ran. On the
replay model, v2 makes more model calls per first verdict (it goes to `lookup_pub` before it
judges; in rehearsal 2.7 calls against 1.9 for v1), but each call carries fewer tokens, so **a v2
run costs about the same as a v1 run** (in rehearsal $0.84 against $0.86 per 1,000 first
verdicts). The same money now buys a verdict that scored almost nothing. Cost would not have caught
this break either.

### 3. A trigger on agent behaviour

Triggers → New trigger, on your dataset. The query:

```json
{
  "calculations": [{ "op": "AVG", "column": "roastjudge.components_scored" }],
  "filters": [{ "column": "name", "op": "=", "value": "invoke_agent roast-judge" }]
}
```

Then set the threshold to `< 1`, the time range to 5 minutes and the frequency to every 2 minutes.
(Honeycomb caps a trigger's time range at 4 times its frequency, so 5 minutes every 1 minute is
rejected.)

Recipient: none is fine for the workshop (the trigger page shows its state), or your own email.

Why `< 1` and not 2: v1 scores about 3 components on a first judgement, but appeals re-score one
component and final rulings score none, so with the load generator's mix of three-turn runs the v1
average sits just above 2. A threshold of 2 would flap on healthy traffic. v2 averages about 0.2.

### 4. Fire it

```bash
npm run prompt v2
```

Wait five to seven minutes (the 5-minute window has to fill with v2 runs, and the trigger only
checks every 2 minutes), and the trigger fires.
Then roll back:

```bash
npm run prompt v1
```

and watch it resolve.

## The query that proves it (green sticky note)

`usd_per_1000_runs` by `gen_ai.prompt.version` (v1 and v2 within a few percent of each other, v2 with more
model calls per run), **and** your trigger in the Triggered state after the v2 flip.

## Teaching beat

- Error rate and latency alerts would not have caught Module 3's break: nothing threw, every
  request returned 200. The alert that works is on **behaviour**: how many components the agent
  actually scored. That is an attribute you chose to put on your own span.
- Cost would not have caught it either: v2 costs about the same per run. Only the behaviour
  attribute moved.
- Cost is a calculated field, not a metric you have to pre-aggregate: tokens are on every chat span,
  so price changes are an edit to one formula, applied to history too.
- An SLO needs a per-event definition of "good". Here that is awkward (a final ruling legitimately
  scores zero components), which is why a trigger on an aggregate is the better fit. If you want an
  SLO anyway, add a `turn` attribute to your agent span first, and make the SLI
  `IF(EQUALS($name, "invoke_agent roast-judge"), GTE($roastjudge.components_scored, 2))` on turn 1
  only.

## If stuck

- **`roastjudge.cost_usd` is empty:** you are looking at non-chat spans; add
  `name starts-with chat`. Check the attribute names in one chat span (`gen_ai.usage.input_tokens`,
  not `prompt_tokens`: see [docs/old-names.md](../docs/old-names.md)).
- **No `gen_ai.prompt.version` on chat spans:** you are on a checkpoint before 3.
  `npm run catchup -- 4` and restart the app.
- **Trigger never fires:** is `npm run load` running? Check `npm run prompt` says `v2` (any app
  restart, including `npm run catchup` and the track (a) restarts, puts it back on `v1`), and give
  it the full window plus two minutes.
- **Only v1 in your data:** your app died over the break; use the fallback dataset `roast-judge-0`
  for the cost query.
