# Act 1 task: add a roast to the corpus

The scripted task for Module 1. Lloyd runs it live on the big screen; you run it with your own
coding agent (Claude Code, Codex or Gemini CLI), wired to Honeycomb from [`telemetry/`](../telemetry/README.md).

It is chosen for a **varied tool mix**: the agent has to read files, edit one, run shell commands
and react to a failing test run. That gives the Module 1 queries something to show. It takes an
agent about 5 minutes.

**It is safe.** This repo is a scratch project. The task edits one data file, runs the tests
locally, and touches nothing outside the repo: no network calls beyond your agent's own model, no
installs, no pushes, no app needed. At the start of Module 2, `npm run catchup -- 2` parks whatever
the agent changed on a `my-work-<timestamp>` branch, so you start Act 2 clean.

## The prompt

Start your agent in the repo root, then paste this as one line:

```text
Read replay/corpus.json and services/pub-guide/pubs.json and tell me how many roasts each pub has. Then add one new roast to replay/corpus.json for the pub with the fewest (if several tie, the first alphabetically by name), following the existing schema exactly: next id, text that names exactly that one pub, components matching what the text mentions, plus expected_v1_label and appeal. Then run `node --disable-warning=ExperimentalWarning --test test/corpus.test.js test/corpus-truth.test.js test/replay-engine.test.js` in the terminal, and if it fails, use the test output to fix your new entry (the corpus-truth tests print the real label and ruling) and run it again until it passes. Don't change any other file.
```

## What a good run looks like

1. **Read.** The agent opens `replay/corpus.json` and `services/pub-guide/pubs.json` (and usually
   `services/model-replay/vocabulary.js`, to see which words count as which component), and
   summarises: ten fictional pubs, four roasts each, so it is a tie and it picks
   **The Burnt End**.
2. **Edit.** It appends `roast-041`: a `text` that names The Burnt End and nothing else, `pub:
   "the-burnt-end"`, `components` drawn from the six ids (`meat`, `nut_roast`, `roasties`,
   `yorkshire`, `gravy`, `veg`), a guessed `expected_v1_label` and an `appeal` with `text`,
   `component` and `expected_ruling`.
3. **Run.** It runs the tests in the terminal. The guess is usually wrong somewhere: the
   `corpus-truth` tests run the real agent pipeline on the new roast and fail with a line like
   `roast-041: expected_v1_label "decent" but the pipeline says "disappointing" (score 5.7)`, and the
   replay-engine tests fail if `components` does not match the keywords in the text.
4. **Fix and re-run.** It corrects the entry from that output and runs the tests again until they
   pass (around 330 tests, under a second).

Why not plain `npm test`? On the workshop branches some of the suite expects the finished `main`
(the agent spans you write in Module 2), so the full suite is red there by design. The three files
above are the ones that check the corpus.

## What you should see in Honeycomb

Your agent's events land in its own dataset (`claude-code`, `codex_cli_rs` or `gemini-cli`) and
its metrics in `agent-metrics`. Module 1's tool-mix query, environment-wide, last 15 minutes:

```
COUNT
GROUP BY  service.name, agent.tool
WHERE     user.email = <your sign-in email>     (or seat = <your seat>)
```

You should see your agent's read tools (`Read`, `read_file`, ...), an edit or write tool, and the
shell tool (`Bash`, `run_shell_command`, `shell`), with the shell count at two or more: the failing
test run and the passing one. `agent.tool` is a derived column defined in
[telemetry/README.md](../telemetry/README.md).
