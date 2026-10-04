# Module 3: find the bad prompt

At the flip, the judge's system prompt changes from `v1` to `v2` (`npm run prompt v2`). Nothing
errors and every request still returns 200, but the v2 judge "trusts its instincts" and mostly stops
calling `score_component`. Your job is to find that in `roast-judge-<seat>` without being told, then
roll back.

Start on `checkpoint-3` (`npm run catchup -- 3`) with the app and `npm run load` running, so your
dataset has v1 traffic before the flip and v2 after it.

## Filter to first verdicts

Every query below filters to `root.http.route = /judge`, the first verdict of a conversation. The
load generator also sends appeals and final rulings, and those score few components **by design**,
on v1 too: an appeal re-scores one component and a final ruling scores none. Left in, they put
healthy v1 runs among the zero-component outliers and muddy BubbleUp. In rehearsal, a BubbleUp over
all turns found 79% v2 in the zero-component selection; on first verdicts alone it was 100% v2
(against 15% in the baseline).

## 1. See that something changed

Paste into the query builder on your dataset (last 30 minutes, so it spans the flip):

```json
{
  "time_range": 1800,
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

Before the flip, first verdicts score about 3 components. After it, the heatmap drops to a band at
0, and the average score goes **up** (5.9 to 6.8 in rehearsal): the judge got more generous by
looking at less. Error rate and latency barely move.

## 2. Ask BubbleUp why

On the heatmap, drag a box around the band at 0 after the flip and open BubbleUp. The top
dimension after the one you selected on is `gen_ai.prompt.version`: the selection is all `v2`, the
baseline mostly `v1`. That attribute is there because you stamped it on the agent span in Module 3
(`checkpoint-3` has it).

## 3. Confirm, then roll back

```json
{
  "time_range": 1800,
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

In rehearsal: v1 3.08 components and 5.85 average score, v2 0.29 and 6.78. Then:

```bash
npm run prompt v1
```

Within a couple of minutes, new first verdicts are back to about 3 components (3.18 in rehearsal).

Restarting the app (including `npm run restart`, `npm run catchup` and `npm run setup`) also puts the prompt back on
`v1`; if your v2 data stops early, check `npm run prompt`.
