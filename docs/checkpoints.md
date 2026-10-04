# Checkpoints

The workshop modules start from known states of this repo, one branch each. `main` is the finished
reference; every `checkpoint-*` branch is `main` with some of the instrumentation blanked out and
replaced by a `// TODO(module-N)` comment that says what to write. The file `CHECKPOINT` at the
repo root names the checkpoint you are on.

| Branch | What it contains | Used by |
|---|---|---|
| `checkpoint-0` | HTTP, Express, undici and the SQLite span only. No openai instrumentation, no `gen_ai.*` spans. | Module 0: environment and first trace |
| `checkpoint-1` | Same code as `checkpoint-0` (Module 1 observes your coding agent, not the app). | Module 1 / Act 1 |
| `checkpoint-2` | Same code again: the openai instrumentation one-liner in `src/telemetry.js` is a `TODO(module-2)`, and `withAgentSpan` / `withToolSpan` in `src/agent.js` are `TODO(module-2)` pass-throughs. | Module 2 start |
| `checkpoint-2-cut` | Module 2 with the `invoke_agent roast-judge` span already written (operation and agent name only); `execute_tool` is still the `TODO(module-2)`. | Module 2 cut line: you write the tool span only |
| `checkpoint-3` | Module 2 done, plus Module 3's stamping: `gen_ai.prompt.name` / `gen_ai.prompt.version` and the `roastjudge.verdict.*` outcome on the agent span. Ready to flip to v2. | Module 3 catch-up (pull by 2:45) |
| `checkpoint-4` | Same code as `checkpoint-3` (the v2 flip and the rollback are runtime switches, not code). `gen_ai.conversation.id` is a `TODO(module-4c)` for track (c). | Module 4: everyone starts here |
| `main` | `checkpoint-4` plus `gen_ai.conversation.id` stamped. The complete reference. | Instructor reference |

Only `src/agent.js`, `src/telemetry.js` and `CHECKPOINT` differ between the branches; everything
else is identical to `main`.

## Catching up

Each checkpoint is also the **solution** to the exercise before it. Exercises are time-boxed (about
20 minutes for the long ones); when the box closes, the front names the branch and anyone still
working runs the catch-up command, so the whole room starts the next module in the same place.
Switching to the branch early is fine: it is the plan, not a failure.

Behind, or want a clean start for the next module? From the repo root:

```bash
npm run catchup -- 2        # or 0, 1, 2-cut, 3, 4
```

It fetches `origin`, parks any uncommitted work (including new files) on a branch called
`my-work-<timestamp>` so nothing is lost, then checks out `checkpoint-N` fresh from `origin`.
Gitignored files (`.env`, your coding agent's settings with keys) are never parked; they stay put.
In the Codespace, catchup restarts the app for you. Locally, stop `npm run dev` and start it again
(under `docker compose up` the services run with `node --watch` and reload on their own).

## Checking your work: `verify` and `check-spans`

Both run one request through the app against an in-memory exporter (nothing goes to Honeycomb, no
key or network needed) and print `PASS` or a list of what is missing.

- `npm run verify` asks "is this checkpoint healthy as shipped?". It reads `CHECKPOINT` and checks
  the expectations for that checkpoint (`scripts/expectations/<name>.js`). It passes on every
  branch straight after `catchup`; if it fails there, your environment is the problem, not your
  code. `npm run verify -- checkpoint-3` checks your tree against another checkpoint's set, e.g.
  "have I done Module 3's stamping?".
- `npm run check-spans` asks "is Module 2 done?". It always checks the Module 2 set: span names and
  kinds, required `gen_ai.*` attributes, the parent/child shape, and `gen_ai.tool.call.id` matching
  the model's tool call. On `checkpoint-0`, `-1` and `-2` it fails with a readable list (for
  example ``missing span `invoke_agent roast-judge` ``); when you have finished Module 2 it prints
  `PASS`. That PASS is the Module 2 green sticky note. It passes on `checkpoint-3`, `checkpoint-4`
  and `main`.

Both start the app and its two fake services on 127.0.0.1. If you run them through Codex and they
print `listen EPERM: operation not permitted 127.0.0.1`, Codex's sandbox is blocking local
listeners, not your code failing. See the Codex note in [tasks/act1.md](../tasks/act1.md) for the
two config lines that allow it.

## Workshop-day setting: default branch

For the workshop window, set the GitHub repo's default branch to `checkpoint-0` (Settings >
General > Default branch), so a fresh clone or a new Codespace lands on Module 0's starting point.
Set it back to `main` afterwards.

## Maintainers: generating the branches

The branches are generated, never edited by hand. The overlays live in `checkpoints/<name>/` on
`main`: each holds `CHECKPOINT` plus only the files that differ from `main`
(`src/agent.js`, and `src/telemetry.js` for checkpoints 0 to 2). The generated branches do not
contain `checkpoints/`.

```bash
scripts/build-checkpoints.sh                        # build all six from HEAD and push to origin
scripts/build-checkpoints.sh --no-push              # build local branches only, push nothing
scripts/build-checkpoints.sh --only checkpoint-3    # just one
scripts/build-checkpoints.sh --source main --remote origin
```

Each branch is the source commit plus one generated commit, built in a throwaway `git worktree`,
so your current branch and working tree are never touched. It pushes with `--force-with-lease` and
is safe to rerun. It needs **git >= 2.17** (`git worktree remove`) and exits with a message if your
git is older. The overlays must be committed first: it builds from the commit, not the working
tree.

### After changing `src/agent.js` or `src/telemetry.js` on main

The overlays are copies of those files with the exercise blanked, so they go stale when `main`
changes. Update them, then regenerate and push the branches:

1. Carry your change into each overlay that has a copy of the file. A three-way merge does it,
   with the previous `main` version as the base:

   ```bash
   git show <old-main-sha>:src/agent.js > /tmp/agent.base.js
   for n in 0 1 2 2-cut 3 4; do
     git merge-file checkpoints/checkpoint-$n/src/agent.js /tmp/agent.base.js src/agent.js
   done
   ```

   (Same for `src/telemetry.js` and checkpoints 0 to 2.) Editing the overlays by hand is fine too.
   Keep `checkpoint-0` and `-1` byte-identical to `checkpoint-2`, and `checkpoint-3` to
   `checkpoint-4`.
2. Run `node --test test/checkpoints.test.js`. It checks that every difference from `main` sits in
   a `TODO(module-` hunk, that no hint pastes the answer, and that `verify` / `check-spans` behave
   as the table above says on every overlay.
3. Commit, then run `scripts/build-checkpoints.sh`.

The rules a hunk must follow: everything outside the TODO blocks stays byte-identical to `main`,
and each TODO block says what to write (span name, kind, attributes) without the code itself.
