# Module 3: break the agent, then find the bad prompt

Part 1, before the 3:00 break: stamp the prompt version on your agent span, let v1 run stamped, then
flip to a new prompt, `v2`. Nothing errors and every request still returns 200, but the v2 judge
"trusts its instincts" and mostly stops calling `score_component`. Part 2, after the break: find
that in `roast-judge-<seat>` without being told, then roll back.

## Part 1: stamp, then flip (2:40 to 2:50)

**Stamp first, flip later.** BubbleUp compares your selection with the rest of the time range. If
the baseline has no prompt version on it, every new attribute looks like "the difference".

1. In `withAgentSpan` in `src/agent.js` (the span you wrote in Module 2):
   - in the attributes you pass to `startActiveSpan`: `gen_ai.prompt.name` = `PROMPT_NAME` and
     `gen_ai.prompt.version` = the `promptVersion` argument (both already in scope). At span start,
     so the app's processor copies them onto the chat spans too;
   - after `run()` returns, on the span: `roastjudge.verdict.score`, `roastjudge.verdict.label` and
     `roastjudge.components_scored`, from `verdict.score`, `verdict.label` and
     `verdict.components_scored`. App namespace: never invent attributes inside `gen_ai.*`.

   (On `checkpoint-2-cut` there is a `TODO(module-3)` marking the spot.)
2. `npm run restart`, then `npm run verify -- checkpoint-3`: PASS means the stamping is right.
   Behind at 2:45? `npm run catchup -- 3` has it done; then you need nothing else.
3. Let v1 run stamped until 2:50 (the load generator does it). Check one trace: the prompt
   attributes are on the agent span and on its chat spans.
4. **At 2:50:** `npm run prompt v2`. It switches at runtime, no restart. `npm run prompt` should
   now print `v2`.

From here until you roll back, **don't restart the app** (no `npm run restart`, `catchup` or
`setup`): any restart puts the prompt back on `v1`.

## Part 2: find it (3:30)

### Time range: from about 2:45 to now

Every query below has no time range: set it after you paste, starting **after you stamped and
restarted** (about 2:45) and ending now. That keeps a stamped v1 baseline before the flip. "Last 30
minutes" would be all v2 by 3:30, with nothing to compare against.

### Filter to first verdicts

Every query filters to `root.http.route = /judge`, the first verdict of a conversation. The load
generator also sends appeals and final rulings, and those score few components **by design**, on
v1 too: an appeal re-scores one component and a final ruling scores none. Left in, they put healthy
v1 runs among the low-component outliers and muddy BubbleUp.

### 1. See that something changed

```json
{
  "calculations": [
    { "op": "HEATMAP", "column": "roastjudge.components_scored" },
    { "op": "AVG", "column": "roastjudge.verdict.score" }
  ],
  "filters": [
    { "column": "name", "op": "=", "value": "invoke_agent roast-judge" },
    { "column": "root.http.route", "op": "=", "value": "/judge" }
  ]
}
```

Before the flip, first verdicts score about 3 components. After it, the heatmap drops to bands at
0 and 1, and the average score goes **up**: the judge got more generous by looking at less. Error
rate and latency move a little (in rehearsal: errors 7% to 10%, p95 3.1 s to 4.2 s, because v2
makes more model calls), the sort of drift you'd shrug at.

### 2. Ask BubbleUp why

On the heatmap, drag a box around **the 0 and 1 bands, after the flip** (everything below 2), and
open BubbleUp. The top dimension after the one you selected on is `gen_ai.prompt.version`: the
selection is all `v2`, the baseline mostly `v1`. (Boxing only the 0 band leaves half the v2 runs in
the baseline, and the difference halves.) That attribute is there because you stamped it in part 1.

If `process.pid` also ranks high, the app restarted inside your time range: move the start to
after that restart.

### 3. Confirm, then roll back

```json
{
  "calculations": [
    { "op": "COUNT" },
    { "op": "AVG", "column": "roastjudge.components_scored" },
    { "op": "AVG", "column": "roastjudge.verdict.score" }
  ],
  "filters": [
    { "column": "name", "op": "=", "value": "invoke_agent roast-judge" },
    { "column": "root.http.route", "op": "=", "value": "/judge" }
  ],
  "breakdowns": ["gen_ai.prompt.version"]
}
```

In rehearsal: v1 3.2 components and an average score of 5.4, v2 0.3 and 6.2; "banging" went from
17% to 29% of first verdicts. Then:

```bash
npm run prompt v1
```

Within a couple of minutes, new first verdicts are back to about 3 components (3.18 in rehearsal).
