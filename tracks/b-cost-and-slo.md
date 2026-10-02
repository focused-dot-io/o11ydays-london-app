# Track (b): cost and an alert on agent behaviour

**Goal:** turn token counts into money per prompt version, and put an alert on what the agent
*does*, so the next bad prompt pages you instead of waiting for a BubbleUp hunt. About 15 minutes.

Start on `checkpoint-4` (`npm run catchup -- 4`) with the app and `npm run load` running. Your
dataset already holds v1 and v2 traffic from Module 3.

## Steps

### 1. A cost derived column

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

Query your dataset over the time since Module 3 (about 2:45 to now):

```
WHERE     name starts-with chat
SUM       roastjudge.cost_usd
GROUP BY  gen_ai.prompt.version
```

Then divide by runs: `COUNT` where `name = invoke_agent roast-judge`, grouped by the same field.
v2 makes more model calls per run (it calls `lookup_pub`, sometimes twice, before it judges), so
each v2 verdict costs more while telling you less.

### 3. A trigger on agent behaviour

Triggers → New trigger, on your dataset:

```
WHERE      name = invoke_agent roast-judge
AVG        roastjudge.components_scored
Threshold  < 1
Time range 5 minutes, frequency every 1 minute
```

Recipient: none is fine for the workshop (the trigger page shows its state), or your own email.

Why `< 1` and not 2: v1 scores about 3 components on a first judgement, but appeals re-score one
component and final rulings score none, so with the load generator's mix of three-turn runs the v1
average sits just above 2. A threshold of 2 would flap on healthy traffic. v2 averages about 0.2.

### 4. Fire it

```bash
npm run prompt v2
```

Wait three or four minutes (the 5-minute window has to fill with v2 runs), and the trigger fires.
Then roll back:

```bash
npm run prompt v1
```

and watch it resolve.

## The query that proves it (green sticky note)

Cost grouped by `gen_ai.prompt.version` showing v2 dearer per run, **and** your trigger in the
Triggered state after the v2 flip.

## Teaching beat

- Error rate and latency alerts would not have caught Module 3's break: nothing threw, every
  request returned 200. The alert that works is on **behaviour**: how many components the agent
  actually scored. That is an attribute you chose to put on your own span.
- Cost is a derived column, not a metric you have to pre-aggregate: tokens are on every chat span,
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
- **Trigger never fires:** is `npm run load` running? Check `npm run prompt` says `v2`, and give it
  the full 5-minute window.
- **Only v1 in your data:** your app died over the break; use the fallback dataset `roast-judge-0`
  for the cost query.
