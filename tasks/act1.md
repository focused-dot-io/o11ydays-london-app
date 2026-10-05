# Act 1 task: add a roast to the corpus

The scripted task for Module 1. Lloyd runs it live on the big screen; you run it with your own
coding agent (Claude Code, Codex or Antigravity CLI), wired to Honeycomb from [`telemetry/`](../telemetry/README.md).

It is chosen for a **varied tool mix**: the agent has to read files, edit one, run shell commands
and react to a failing test run. That gives the Module 1 queries something to show. It takes an
agent 5 to 8 minutes; Module 1's queries start while it is still running.

**It is safe.** This repo is a scratch project. The task edits one data file, runs the tests
locally, and touches nothing outside the repo: no network calls beyond your agent's own model, no
installs, no pushes, no app needed. At the start of Module 2, `npm run catchup -- 2` parks whatever
the agent changed on a `my-work-<timestamp>` branch, so you start Act 2 clean.

## The prompt

Start your agent in the repo root, then paste this as one line:

```text
Read replay/corpus.json and services/pub-guide/pubs.json and tell me how many roasts each pub has. Then add one new roast to replay/corpus.json for the pub with the fewest (if several tie, the first alphabetically by name), following the existing schema exactly: next id, text that names exactly that one pub, components matching what the text mentions, plus an appeal. Set expected_v1_label and appeal.expected_ruling to "TBD": don't work them out, the tests will tell you. Then make `node --disable-warning=ExperimentalWarning --test test/corpus.test.js test/corpus-truth.test.js test/replay-engine.test.js` pass. Don't change any other file. Use your file read and edit tools for the JSON, not shell scripts.
```

## What a good run looks like

1. **Read.** The agent opens `replay/corpus.json` and `services/pub-guide/pubs.json` (and usually
   `services/model-replay/vocabulary.js`, to see which words count as which component), and
   summarises: ten fictional pubs, four roasts each, so it is a tie and it picks
   **The Burnt End**.
2. **Edit.** It appends `roast-041`: a `text` that names The Burnt End and nothing else, `pub:
   "the-burnt-end"`, `components` drawn from the six ids (`meat`, `nut_roast`, `roasties`,
   `yorkshire`, `gravy`, `veg`), and an `appeal` with `text` and `component`. `expected_v1_label`
   and `appeal.expected_ruling` are `"TBD"`, as the prompt says.
3. **Run.** It runs the tests in the terminal, and the first run always fails: the
   `corpus-truth` tests run the real agent pipeline on the new roast and print lines like
   `roast-041: expected_v1_label "TBD" but the pipeline says "decent" (score 6.8)` and
   `roast-041: expected_ruling "TBD" but the pipeline rules "upheld" (scores [...])`. The replay-engine tests also
   fail if `components` does not match the keywords in the text.
4. **Fix and re-run.** Nobody tells it how to recover: it reads the failure, fills in the label
   and ruling from that output, and runs the tests again until they pass (around 330 tests, under
   a second).

Why not plain `npm test`? It is green on your branch too, but the part of the suite that expects
the finished `main` (the agent spans you write in Module 2) is skipped there, and the rest covers
the whole app. The three files above are the ones that check the corpus.

## What you should see in Honeycomb

Your agent's events land in its own dataset (`claude-code`, `antigravity-cli`, or for Codex
`codex-app-server` when interactive and `codex_exec` under `codex exec`; see
[telemetry/README.md](../telemetry/README.md#which-agent-which-files)) and its metrics in
`agent-metrics` (Antigravity sends no metrics: its events come from hooks). You don't need to
know which dataset: the query below is environment-wide and finds you by `seat`. Module 1's
tool-mix query, last 15 minutes.
Paste it into the query builder, with the seat number from your seat card in place of
`<your seat>`:

```json
{
  "time_range": 900,
  "calculations": [{ "op": "COUNT" }],
  "breakdowns": ["service.name", "agent.tool"],
  "filters": [
    { "column": "seat", "op": "=", "value": "<your seat>" },
    { "column": "event.name", "op": "in", "value": ["tool_result", "codex.tool_result", "agy.tool_result"] },
    { "column": "name", "op": "does-not-start-with", "value": "event otel" }
  ]
}
```

The seat value is a string, e.g. `"value": "7"`. Every agent's events carry `seat` (it comes from
`OTEL_RESOURCE_ATTRIBUTES`), so this works whichever agent you use and however you signed in.

The other two filters count each tool call once. Without them Claude Code reports every call three
times (a `tool_decision` log, a `tool_result` log and a span) and Codex twice (its log and a trace
copy named `event otel/src/tool_result.rs:54`): `event.name` keeps one result event per agent, and
the `name` filter drops Codex's trace copy.

Metrics share your agent's `service.name`: see the `agent-metrics` note in [telemetry/README.md](../telemetry/README.md#which-agent-which-files).

You should see your agent's read tools (`Read`, `view_file`, ...), an edit or write tool (`Edit`,
`replace_file_content`, `apply_patch`, ...), and the shell tool (`Bash`, `run_command`,
`exec_command`), with the shell count at two or more: the failing test run and the passing one.
Codex reads files through its shell, so it shows only `exec_command` (and `exec`) and
`apply_patch`. In rehearsal, an Antigravity run (`gemini-3.8-flash-high`) took about 8 minutes:
20 `run_command`, 13 `view_file`, 2 `replace_file_content`. Claude Code's one rehearsal (before
the prompt asked for file tools) ran all 11 calls as `Bash`. `agent.tool` is a calculated field defined in
[telemetry/README.md](../telemetry/README.md).
