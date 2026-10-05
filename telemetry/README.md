# Coding-agent telemetry (Act 1)

Wire the coding agent you already use to send its telemetry to the workshop Honeycomb environment,
scoped to this repo only: nothing changes in your global agent setup, and your other projects send
nothing. One template per agent, with exactly two blanks to fill in from your seat card:

- `<SEAT>`: your seat number (e.g. `17`);
- `<KEY>`: the workshop ingest key.

Every filled-in file is **gitignored** (`.claude/telemetry.local.json`, `.agents/`,
`.codex-home/`), so your key never gets committed and `npm run catchup` never parks it.

All three send to `https://api.honeycomb.io`, each lands in its own dataset (named by its
`service.name`), add `seat=<seat>` through `OTEL_RESOURCE_ATTRIBUTES` and keep prompt content off.
Claude Code and Codex also send metrics to one shared **`agent-metrics`** dataset via the
`x-honeycomb-dataset` header. Antigravity has no telemetry of its own: a hook script in this repo
sends its events (see below), and it has no metrics or token counts to send.

**Your sign-in email is visible to the room.** Claude Code and Codex attach `user.email`; the
Antigravity hook does not, so filter on `seat` (which every agent carries) to find yourself. Wire your agent on your own machine with your
own sign-in only.

## Which agent, which files

| Agent | Template | Copy it to | Lands in dataset | Notes |
|---|---|---|---|---|
| Claude Code | `claude-settings.local.json` | `.claude/telemetry.local.json`, then start with `claude --settings .claude/telemetry.local.json` | `claude-code` | Cost is informational only on Pro/Max. Traces are beta (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Metrics every 10 s instead of 60 s |
| Codex CLI | `codex-config.toml` + `envrc` | `.codex-home/config.toml`; `export CODEX_HOME=$PWD/.codex-home` (or copy `envrc` to `.envrc` for direnv) | `codex-app-server` (interactive `codex`), `codex_exec` (`codex exec`); see the Codex notes below | Metrics overridden from the `statsig` default. Cost only with an API key. Tool arguments and output previews are exported even with prompt logging off |
| Antigravity CLI (`agy`) | `agy-hooks.json` + `agy.env` | `.agents/hooks.json` and `.agents/agy.env` | `antigravity-cli` | Events from hooks, via `telemetry/agy-hook.mjs`: one span per tool call, loop pass and turn end. No tokens, no metrics, no `user.email`. Never sends prompts, tool arguments or tool output |

Metrics from Claude Code and Codex land in one shared dataset, `agent-metrics`, but keep the agent's own
`service.name` (the same one as its events). So grouping by `service.name` merges an agent's
events and metrics. To see metrics on their own, choose the `agent-metrics` dataset, then group by
`service.name` to compare agents.

Bring your own agent, signed in with a personal account: one of these three is a prerequisite, and
there is no fallback agent. Antigravity CLI replaced Gemini CLI, which stopped serving personal
Google accounts on 18 June 2026.

### Claude Code

```bash
mkdir -p .claude
cp telemetry/claude-settings.local.json .claude/telemetry.local.json
# edit: replace <KEY> (twice) and <SEAT>
claude --settings .claude/telemetry.local.json
```

Why `--settings`: since v2.1.282, Claude Code **ignores** telemetry variables
(`CLAUDE_CODE_ENABLE_TELEMETRY`, the exporters, `OTEL_EXPORTER_OTLP_*` endpoints and headers) set in
a repository's `.claude/settings.json` or `.claude/settings.local.json`, so a cloned repo cannot
turn telemetry on behind your back. A file you pass with `--settings` is honoured, and it still
applies only to sessions you start that way, in this repo. Don't name it `.claude/settings.local.json`:
Claude Code also loads that path on its own as project settings and warns that it ignores every
telemetry variable in it, even though the `--settings` copy is applied. `/status` shows which variables were
ignored. (Docs: <https://code.claude.com/docs/en/monitoring-usage> and
<https://code.claude.com/docs/en/settings-reference#variables-claude-code-ignores-in-env>.)

Prompt text stays off: the template does not set `OTEL_LOG_USER_PROMPTS`.

### Codex CLI

Codex deliberately ignores `[otel]` in a project's `.codex/config.toml` (it decides where your data
goes), and no environment variable turns it on. But `CODEX_HOME` moves Codex's whole home, and a
home's `config.toml` may set `[otel]`. So:

```bash
mkdir -p .codex-home
cp telemetry/codex-config.toml .codex-home/config.toml   # replace <KEY> (three times)
export CODEX_HOME=$PWD/.codex-home
export OTEL_RESOURCE_ATTRIBUTES=seat=<seat>               # your seat number
codex login                                              # once: the fresh home has no credentials
codex
```

In the Codespace, two of those lines change:

```bash
# The container cannot create the namespaces Codex's Linux sandbox needs; the Codespace is the sandbox.
sed -i 's/^sandbox_mode = .*/sandbox_mode = "danger-full-access"/' .codex-home/config.toml
codex login --device-auth    # prints a URL and a one-time code for your own browser; nothing opens here
```

direnv users: `cp telemetry/envrc .envrc`, fill in the seat, `direnv allow`. A fresh home also means
a separate session history. The IDE extension only sees this home if the editor was launched from
that shell (`code .`), so use the CLI today.
(Docs: <https://developers.openai.com/codex/config-advanced>, the `[otel]` section.)

### Antigravity CLI (agy)

Antigravity has no OpenTelemetry exporter (it is a requested feature,
<https://github.com/google-antigravity/antigravity-cli/issues/366>), but it runs **hooks** from the
workspace's `.agents/hooks.json`. The template registers `telemetry/agy-hook.mjs` for three events
that only observe (`PostToolUse`, `PostInvocation`, `Stop`); the script sends one span per event to
Honeycomb, with every span of a conversation in one trace.

```bash
mkdir -p .agents
cp telemetry/agy-hooks.json .agents/hooks.json
cp telemetry/agy.env .agents/agy.env      # replace <KEY> and <SEAT>
agy
```

agy loads workspace hooks only once you **trust the folder** (it asks on first start), and reads
`hooks.json` at startup, so restart `agy` after changing it. In the Codespace, `agy` prints a
sign-in URL to open in your own browser. The span attributes are `tool_name` (on `PostToolUse`),
`conversation.id`, `model`, `agy.step`, `agy.invocation`, `agy.termination_reason` (on `Stop`),
`error` and `error.message`. Not `user.email`, and no token counts: the hook payloads carry neither.

## The unified view: calculated fields

The three agents name the same things differently. Four **environment-wide** calculated fields
(Environment settings → Schema → Calculated fields, then **Add new Calculated Field**) `COALESCE`
them into one vocabulary, so one query covers every agent in the room:

| Calculated field | Claude Code | Codex | Antigravity CLI |
|---|---|---|---|
| `agent.input_tokens` | `input_tokens` + `cache_read_tokens` + `cache_creation_tokens` (on `api_request`) | `input_token_count` (on `codex.sse_event`) | (none) |
| `agent.output_tokens` | `output_tokens` | `output_token_count` | (none) |
| `agent.tool` | `tool_name` | `tool_name` | `tool_name` (on `agy.tool_result`) |
| `agent.session` | `session.id` | `conversation.id` | `conversation.id` |

Definitions to paste:

```
agent.input_tokens    IF(EXISTS($input_tokens), SUM($input_tokens, COALESCE($cache_read_tokens, 0), COALESCE($cache_creation_tokens, 0)), INT($input_token_count))
agent.output_tokens   COALESCE($output_tokens, INT($output_token_count))
agent.tool            $tool_name
agent.session         COALESCE($session.id, $conversation.id)
```

(Codex and Claude Code share `tool_name`, and the Antigravity hook emits `tool_name` and
`conversation.id` on purpose, so `agent.tool` needs no `COALESCE` and the others need no new arms.
`COALESCE` rejects a column that does not exist yet in the environment, so the older
`COALESCE($tool_name, $function_name)` (`function_name` was Gemini CLI's) cannot be created now that
nothing sends `function_name`. Codex sends `input_token_count` and `output_token_count` as strings,
so `INT()` turns them into numbers `SUM` can add. Claude Code's `input_tokens` counts only the uncached part
of the prompt (a long session is almost all cache reads), while Codex's `input_token_count` already
includes cached input, so `agent.input_tokens` adds Claude's two cache fields back in; without them
Claude looks almost free on input. Antigravity has no token counts, so it is missing from the token
queries below.)

Module 1's queries, environment-wide. Paste each into the query builder. They have no
`time_range`: use the last 24 hours, which includes the runs seeded the day before.

1. Tokens by agent and model. `meta.signal_type = log` counts each model call once (Claude Code
   puts its token counts on both the `api_request` log and a trace span, which would double it);
   `exists` drops the rows from datasets with no token counts. Query 4 uses the same filters.

   ```json
   {
     "calculations": [
       { "op": "SUM", "column": "agent.input_tokens" },
       { "op": "SUM", "column": "agent.output_tokens" }
     ],
     "breakdowns": ["service.name", "model"],
     "filters": [
       { "column": "meta.signal_type", "op": "=", "value": "log" },
       { "column": "agent.input_tokens", "op": "exists" }
     ]
   }
   ```

2. Tool mix, one row per tool call (see [tasks/act1.md](../tasks/act1.md#what-you-should-see-in-honeycomb)
   for why both filters are needed):

   ```json
   {
     "calculations": [{ "op": "COUNT" }],
     "breakdowns": ["service.name", "agent.tool"],
     "filters": [
       { "column": "event.name", "op": "in", "value": ["tool_result", "codex.tool_result", "agy.tool_result"] },
       { "column": "name", "op": "does-not-start-with", "value": "event otel" }
     ]
   }
   ```

3. Tool calls per session, longest first: query 2's filters, grouped by session:

   ```json
   {
     "calculations": [{ "op": "COUNT" }],
     "breakdowns": ["service.name", "agent.session"],
     "filters": [
       { "column": "event.name", "op": "in", "value": ["tool_result", "codex.tool_result", "agy.tool_result"] },
       { "column": "name", "op": "does-not-start-with", "value": "event otel" }
     ],
     "orders": [{ "op": "COUNT", "order": "descending" }]
   }
   ```

4. The limits question, tokens by person over time. Use tokens, not cost: cost is informational on
   subscription plans and missing entirely for Codex on a ChatGPT plan.

   ```json
   {
     "calculations": [
       { "op": "SUM", "column": "agent.input_tokens" },
       { "op": "SUM", "column": "agent.output_tokens" }
     ],
     "breakdowns": ["user.email"],
     "filters": [
       { "column": "meta.signal_type", "op": "=", "value": "log" },
       { "column": "agent.input_tokens", "op": "exists" }
     ]
   }
   ```

Filter to yourself with `seat = <your seat>`, or `user.email = <your sign-in email>` (Claude Code
and Codex only).

## Codex rehearsal notes (CLI 0.160.0)

The service name, and so the dataset, depends on how Codex is launched:

| How you start Codex | Dataset your session lands in |
|---|---|
| `codex` (interactive) | `codex-app-server`. The TUI runs its session on an in-process app server, so prompts, tokens and tool calls carry that service name. `codex_cli_rs` gets only a startup log and a metric |
| `codex exec` | `codex_exec` |
| A CLI launched from Codex Desktop | `codex-desktop` (it inherits `Codex Desktop`) |

Don't hunt for the dataset: query environment-wide and filter by your `seat`, which every launch
mode carries. (Verified on 0.160.0, 2026-10-04; older CLIs sent interactive sessions as
`codex_cli_rs`, so expect the name to move again.)

For Codex event queries, use `meta.signal_type = log` to avoid counting the same activity from
both logs and traces. Filter token totals to `event.name = codex.sse_event` and
`event.kind = response.completed`; tool mix to `event.name = codex.tool_result`; turns per
`conversation.id` to `event.name = codex.user_prompt`.

The normalisation expressions above assume the referenced columns exist after all three agents
have been seeded. For a Codex-only rehearsal, use `input_token_count`, `output_token_count`,
`tool_name` and `conversation.id` directly: `COALESCE` can reject an expression referring to a
column that does not yet exist. Current Codex traces also emit `gen_ai.usage.*`; choose one
signal/event population when summing tokens.

The Act 1 tests, `npm run check-spans` and `npm run verify` open listeners on 127.0.0.1. Codex's
default workspace-write sandbox blocks them (`listen EPERM`), so the template sets
`sandbox_mode = "workspace-write"` with `[sandbox_workspace_write] network_access = true`. With
that, plain `codex exec` or `codex` runs all three without an escalation prompt (tested on macOS).

**In the Codespace the sandbox does not work at all.** Codex's Linux sandbox is bubblewrap, which
needs an unprivileged user namespace, and the Codespace container forbids them (`unshare -Ur`
fails with `Operation not permitted`; seccomp is on and the process holds no capabilities). So
every sandboxed command, down to `codex sandbox -- echo hello`, fails with
`bwrap: No permissions to create a new namespace`, before `listen EPERM` could even come up.
Codex does not fall back: `codex exec` warns that its "Linux sandbox uses bubblewrap and needs
access to create user namespaces", runs the command anyway, gets the `bwrap` error back as the
command's output, and hands that error over as its final answer. Only `danger-full-access` runs
anything, because it skips bubblewrap. Hence the `sed` in the Codespace steps above;
`codex --sandbox danger-full-access` does the same for one session. The Codespace is the sandbox.
(Verified 2026-10-05 on a checkpoint-0 Codespace, Debian 13, CLI 0.160.0: `codex sandbox`, which
needs no sign-in, fails for every command; signed in, `codex exec` with either form of
`danger-full-access` ran `echo`, a 127.0.0.1 listener and `npm test`, and the run's events and
metrics landed in `codex_exec` and `agent-metrics` with `seat`.)

`codex login --device-auth` works headlessly there: it prints `https://auth.openai.com/codex/device`
and a one-time code that expires in 15 minutes, and waits. Nothing tries to open a browser in the
Codespace.

Codex reads files with its shell tool, so its tool mix is `exec_command` (and `exec`) plus
`apply_patch`, with no separate read tool. Why the tool-mix query needs both filters:
[tasks/act1.md](../tasks/act1.md#what-you-should-see-in-honeycomb).

`codex logout` (or `/logout`) removes the credentials in the current `CODEX_HOME`. Run it from the
shell where `CODEX_HOME=$PWD/.codex-home` is exported, or you sign out of your global Codex home
instead.

## Antigravity rehearsal notes (agy 1.2.16)

`agy` runs hook commands from the `.agents/` directory, which is why the template says
`node ../telemetry/agy-hook.mjs`. A hook that fails is shown to the model, and in rehearsal the
agent left the Act 1 task to "fix" it (it copied the hook script into `.agents/`). So if the
hooks error, quit `agy`, fix `.agents/hooks.json`, and start again rather than letting the agent
repair it. A clean run sent 74 events: 37 `agy.invocation`, 35 `agy.tool_result`, 2 `agy.stop`.
Set `AGY_HOOK_DEBUG=1` in `.agents/agy.env` to append every raw hook payload to
`.agents/agy-hook-debug.jsonl` (local only; the payloads include tool arguments).

## At the end of the day

Run `/logout` in the agent you wired (Claude Code, Codex and Antigravity CLI all have it), then stop your
Codespace. The agent's session is not tied to the Codespace's lifecycle, so a signed-in agent would
otherwise sit in a stopped Codespace.

## Status of these templates

Cold-tested against the US workshop environment: Claude Code with `--settings` (2026-10-03),
Codex under a repo-local `CODEX_HOME` and Antigravity's hooks (both 2026-10-04): events land with
`seat`, metrics in `agent-metrics`, no prompt text, and the calculated fields resolve across all
three. In the Codespace (2026-10-05): `codex login --device-auth` prints its URL and code as
expected, and Codex's sandbox cannot run there, so the Codespace steps set `danger-full-access`.
